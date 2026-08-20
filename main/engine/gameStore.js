'use strict';

/**
 * Live game store — the heart of the app.
 *
 * Owns the five source slots, polls each one independently, tracks per-source
 * health, recomputes the ladder, runs event detection, and pushes a single
 * immutable snapshot to the UI.
 *
 * Isolation guarantees:
 *  - every read is wrapped and awaited via allSettled, so one dead source can
 *    never stall, freeze or crash the others
 *  - a failing read never wipes the last good score; it only degrades health
 *  - the ladder is recomputed from whatever data is currently valid
 */

const { EventEmitter } = require('events');
const adapters = require('../adapters');
const browserPool = require('../lib/browserPool');
const { computeLadder } = require('./ladder');
const { EventDetector } = require('./events');
const { matchClub, abbreviate } = require('./teams');
const { STATUS } = require('../lib/model');

const HEALTH = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  STALE: 'stale',
  ERROR: 'error',
  MANUAL: 'manual'
};

const MAX_LOG = 200;

class GameStore extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.detector = new EventDetector();
    this.timer = null;
    this.ticking = false;
    this.log = [];
    this.startedAt = Date.now();
    this.lastTickAt = null;

    /** @type {Map<string, object>} runtime state per slot (never persisted) */
    this.runtime = new Map();
    for (const slot of this.config.slots) this.runtime.set(slot.id, this.blankRuntime());

    // Startup is deliberately cold. URLs, types, mappings and manual values are
    // all restored, but nothing is treated as live until the operator presses
    // Connect — a half-connected feed on boot is worse than no feed at all.
    this.store.update((cfg) => {
      for (const s of cfg.slots) s.enabled = false;
    });

    this.ladderRows = [];
    this.recompute();
  }

  get config() {
    return this.store.load();
  }

  blankRuntime() {
    return {
      health: HEALTH.IDLE,
      game: null,
      lastGoodAt: null,
      lastAttemptAt: null,
      lastError: null,
      warning: null,
      via: null,
      consecutiveFailures: 0,
      validated: false,
      flash: null
    };
  }

  /* ---------------------------------------------------------------- */
  /* Slot configuration                                               */
  /* ---------------------------------------------------------------- */

  updateSlot(id, patch) {
    this.store.update((cfg) => {
      const slot = cfg.slots.find((s) => s.id === id);
      if (!slot) return;
      const prevManual = slot.manual;
      const prevMapping = slot.mapping;
      Object.assign(slot, patch);
      if (patch.manual) slot.manual = { ...prevManual, ...patch.manual };
      if (patch.mapping) slot.mapping = { ...prevMapping, ...patch.mapping };
    });

    const slot = this.config.slots.find((s) => s.id === id);

    // Manual edits must land on the ladder immediately, not on the next poll.
    if (slot?.manualMode && slot.enabled && patch.manual) {
      this.tickSlot(slot).then((events) => {
        const ladderEvents = this.recompute();
        const all = [...events, ...ladderEvents];
        if (all.length) this.pushEvents(all);
        this.push(all);
      });
      return this.snapshot();
    }

    // Re-mapping a game to different clubs changes the ladder straight away.
    if (patch.mapping) {
      const ladderEvents = this.recompute();
      if (ladderEvents.length) this.pushEvents(ladderEvents);
      this.push(ladderEvents);
    }

    return this.snapshot();
  }

  /** Connect (or re-validate) a slot: one read that must produce a usable game. */
  async connect(id) {
    const slot = this.config.slots.find((s) => s.id === id);
    if (!slot) throw new Error('Unknown game slot');

    const rt = this.runtime.get(id) || this.blankRuntime();
    this.runtime.set(id, rt);

    if (needsUrl(slot) && !String(slot.url || '').trim()) {
      rt.health = HEALTH.ERROR;
      rt.lastError = 'Paste a scoring link first';
      this.push();
      return { ok: false, error: rt.lastError };
    }

    rt.health = HEALTH.CONNECTING;
    rt.lastError = null;
    rt.warning = null;
    this.push();

    // A reconnect must not be read as scoring: drop remembered score history.
    this.detector.forgetGame(id);

    try {
      const result = await this.readSlot(slot);
      const validation = validateGame(result.game);
      if (!validation.ok) throw new Error(validation.error);

      rt.game = result.game;
      rt.via = result.via;
      rt.warning = result.warning || null;
      rt.lastGoodAt = Date.now();
      rt.lastAttemptAt = rt.lastGoodAt;
      rt.consecutiveFailures = 0;
      rt.validated = true;
      rt.health = slot.manualMode ? HEALTH.MANUAL : HEALTH.CONNECTED;

      this.store.update((cfg) => {
        const s = cfg.slots.find((x) => x.id === id);
        if (s) {
          s.enabled = true;
          if (!s.manualMode) s.type = result.game.sourceType;
          // Seed manual fields so a later switch to manual starts from reality.
          s.manual = {
            ...s.manual,
            homeTeam: result.game.homeTeam,
            awayTeam: result.game.awayTeam,
            homeGoals: result.game.homeGoals,
            homeBehinds: result.game.homeBehinds,
            awayGoals: result.game.awayGoals,
            awayBehinds: result.game.awayBehinds,
            quarter: result.game.quarter || 1,
            clock: result.game.clock || '',
            status: result.game.status
          };
        }
      });

      this.autoMap(id, result.game);
      this.detector.diffGame(id, result.game, slot.label); // seeds, fires nothing
      this.recompute();
      this.ensureTimer();
      this.push();
      return { ok: true, game: result.game, warning: rt.warning };
    } catch (err) {
      rt.health = HEALTH.ERROR;
      rt.lastError = err.message || String(err);
      rt.lastAttemptAt = Date.now();
      rt.validated = false;
      this.push();
      return { ok: false, error: rt.lastError };
    }
  }

  /** Connect every slot that has something to connect. Failures are per-slot. */
  async connectAll() {
    const targets = this.config.slots.filter((s) => !needsUrl(s) || String(s.url || '').trim());
    const results = await Promise.allSettled(targets.map((s) => this.connect(s.id)));
    return targets.map((s, i) => ({
      id: s.id,
      label: s.label,
      ...(results[i].status === 'fulfilled' ? results[i].value : { ok: false, error: String(results[i].reason) })
    }));
  }

  disconnect(id) {
    const rt = this.runtime.get(id);
    if (rt) {
      rt.health = HEALTH.IDLE;
      rt.validated = false;
      rt.lastError = null;
      rt.warning = null;
      rt.game = null;
      rt.lastGoodAt = null;
    }
    this.detector.forgetGame(id);
    browserPool.destroy(id);
    this.store.update((cfg) => {
      const s = cfg.slots.find((x) => x.id === id);
      if (s) s.enabled = false;
    });
    this.recompute();
    this.push();
    return this.snapshot();
  }

  /** Clear a slot completely — URL, mapping, manual values and all runtime state. */
  clearSlot(id) {
    this.disconnect(id);
    this.store.update((cfg) => {
      const s = cfg.slots.find((x) => x.id === id);
      if (!s) return;
      s.url = '';
      s.manualMode = false;
      s.mapping = { home: null, away: null };
      s.manual = {
        homeTeam: '', awayTeam: '',
        homeGoals: 0, homeBehinds: 0, awayGoals: 0, awayBehinds: 0,
        quarter: 1, clock: '', status: 'LIVE'
      };
    });
    this.push();
    return this.snapshot();
  }

  /**
   * Switch a slot into or out of manual control.
   * Entering manual seeds from the last known live values, so the ladder does
   * not lurch when a feed is taken over by hand.
   */
  setManual(id, on) {
    const rt = this.runtime.get(id);
    this.store.update((cfg) => {
      const s = cfg.slots.find((x) => x.id === id);
      if (!s) return;
      s.manualMode = !!on;
      if (on && rt?.game) {
        s.manual = {
          homeTeam: rt.game.homeTeam,
          awayTeam: rt.game.awayTeam,
          homeGoals: rt.game.homeGoals,
          homeBehinds: rt.game.homeBehinds,
          awayGoals: rt.game.awayGoals,
          awayBehinds: rt.game.awayBehinds,
          quarter: rt.game.quarter || 1,
          clock: rt.game.clock || '',
          status: rt.game.status
        };
      }
    });
    if (on) {
      browserPool.destroy(id);
      if (rt) {
        rt.health = HEALTH.MANUAL;
        rt.validated = true;
        rt.lastError = null;
      }
      this.store.update((cfg) => {
        const s = cfg.slots.find((x) => x.id === id);
        if (s) s.enabled = true;
      });
      this.tickSlot(this.config.slots.find((s) => s.id === id)).then(() => this.push());
      this.ensureTimer();
    } else if (rt) {
      rt.health = rt.validated ? HEALTH.CONNECTED : HEALTH.IDLE;
    }
    this.push();
    return this.snapshot();
  }

  /* ---------------------------------------------------------------- */
  /* Club mapping                                                     */
  /* ---------------------------------------------------------------- */

  autoMap(id, game) {
    const clubs = this.config.ladder.clubs || [];
    if (!clubs.length) return;
    const slot = this.config.slots.find((s) => s.id === id);
    if (!slot) return;

    const patch = {};
    if (!slot.mapping.home) {
      const m = matchClub(game.homeTeam, clubs);
      if (m) patch.home = m.key;
    }
    if (!slot.mapping.away) {
      const m = matchClub(game.awayTeam, clubs);
      if (m) patch.away = m.key;
    }
    if (Object.keys(patch).length) this.updateSlot(id, { mapping: patch });
  }

  /** Re-run auto-mapping for every connected slot (after a new ladder is pasted). */
  remapAll() {
    for (const [id, rt] of this.runtime) {
      if (rt.game) this.autoMap(id, rt.game);
    }
    this.recompute();
    this.push();
  }

  /* ---------------------------------------------------------------- */
  /* Polling                                                          */
  /* ---------------------------------------------------------------- */

  async readSlot(slot) {
    const type = slot.manualMode ? 'manual' : slot.type || adapters.detectType(slot.url) || 'record2020';
    const adapter = adapters.get(type);
    if (!adapter) throw new Error(`No adapter for source type "${type}"`);
    return adapter.read({ id: slot.id, url: slot.url, manual: slot.manual });
  }

  async tickSlot(slot) {
    if (!slot) return [];
    const rt = this.runtime.get(slot.id) || this.blankRuntime();
    this.runtime.set(slot.id, rt);
    rt.lastAttemptAt = Date.now();

    try {
      const { game, via, warning } = await this.readSlot(slot);
      const validation = validateGame(game);
      if (!validation.ok) throw new Error(validation.error);

      const events = this.detector.diffGame(slot.id, game, slot.label);
      rt.game = game;
      rt.via = via;
      rt.warning = warning || null;
      rt.lastGoodAt = Date.now();
      rt.consecutiveFailures = 0;
      rt.lastError = null;
      rt.validated = true;
      rt.health = slot.manualMode ? HEALTH.MANUAL : HEALTH.CONNECTED;
      return events;
    } catch (err) {
      rt.consecutiveFailures += 1;
      rt.lastError = err.message || String(err);
      // Keep the last good score on screen; only the health state degrades.
      if (rt.game) {
        rt.health = rt.consecutiveFailures >= 3 ? HEALTH.ERROR : HEALTH.STALE;
      } else {
        rt.health = HEALTH.ERROR;
      }
      return [];
    }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const slots = this.config.slots.filter((s) => s.enabled && (!needsUrl(s) || s.url));
      const results = await Promise.allSettled(slots.map((s) => this.tickSlot(s)));

      const events = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) events.push(...r.value);
      }

      this.applyStaleness();
      const ladderEvents = this.recompute();
      events.push(...ladderEvents);

      if (events.length) this.pushEvents(events);
      this.lastTickAt = Date.now();
      this.push(events);
    } finally {
      this.ticking = false;
    }
  }

  applyStaleness() {
    const staleAfter = this.config.settings.staleAfter || 30000;
    const now = Date.now();
    for (const [id, rt] of this.runtime) {
      const slot = this.config.slots.find((s) => s.id === id);
      if (!slot || !slot.enabled || slot.manualMode) continue;
      if (rt.health === HEALTH.CONNECTED && rt.lastGoodAt && now - rt.lastGoodAt > staleAfter) {
        rt.health = HEALTH.STALE;
      }
    }
  }

  ensureTimer() {
    const interval = Math.max(2000, Number(this.config.settings.pollInterval) || 5000);
    if (this.timer && this.timerInterval === interval) return;
    this.stopTimer();
    this.timerInterval = interval;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[gameStore] tick failed:', err));
    }, interval);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.timerInterval = null;
  }

  setPollInterval(ms) {
    this.store.update((cfg) => {
      cfg.settings.pollInterval = Math.min(60000, Math.max(2000, Number(ms) || 5000));
      cfg.settings.staleAfter = Math.max(15000, cfg.settings.pollInterval * 5);
    });
    if (this.timer) this.ensureTimer();
    this.push();
  }

  /* ---------------------------------------------------------------- */
  /* Ladder                                                           */
  /* ---------------------------------------------------------------- */

  liveGames() {
    return this.config.slots
      .filter((s) => s.enabled)
      .map((s) => {
        const rt = this.runtime.get(s.id);
        return rt?.game
          ? { id: s.id, game: rt.game, homeKey: s.mapping.home, awayKey: s.mapping.away }
          : null;
      })
      .filter(Boolean);
  }

  /** Recompute the ladder and return any position-change events. */
  recompute() {
    const clubs = this.config.ladder.clubs || [];
    if (!clubs.length) {
      this.ladderRows = [];
      return [];
    }
    const { rows } = computeLadder(clubs, this.liveGames());
    this.ladderRows = rows;
    return this.detector.diffLadder(rows);
  }

  setLadder(clubs, raw) {
    this.store.update((cfg) => {
      cfg.ladder = { clubs, raw: raw || '', updatedAt: new Date().toISOString() };
      // Mappings point at old club keys — drop them and re-derive.
      for (const s of cfg.slots) s.mapping = { home: null, away: null };
    });
    this.detector.seededLadder = false;
    this.detector.prevLadder.clear();
    this.remapAll();
    return this.snapshot();
  }

  /* ---------------------------------------------------------------- */
  /* Log + snapshot                                                   */
  /* ---------------------------------------------------------------- */

  pushEvents(events) {
    // Only meaningful ladder moments reach the movement log.
    const logged = events.filter((e) => e.type === 'position' || e.type === 'final' || e.type === 'note');
    if (!logged.length) return;
    this.log = [...logged.reverse(), ...this.log].slice(0, MAX_LOG);
  }

  clearLog() {
    this.log = [];
    this.push();
    return this.snapshot();
  }

  snapshot() {
    const cfg = this.config;
    return {
      settings: cfg.settings,
      ladderMeta: {
        clubCount: (cfg.ladder.clubs || []).length,
        updatedAt: cfg.ladder.updatedAt,
        raw: cfg.ladder.raw || ''
      },
      clubs: (cfg.ladder.clubs || []).map((c) => ({ key: c.key, name: c.name })),
      slots: cfg.slots.map((s) => {
        const rt = this.runtime.get(s.id) || this.blankRuntime();
        return {
          id: s.id,
          label: s.label,
          type: s.type,
          url: s.url,
          enabled: s.enabled,
          manualMode: s.manualMode,
          manual: s.manual,
          mapping: s.mapping,
          health: rt.health,
          via: rt.via,
          warning: rt.warning,
          lastError: rt.lastError,
          lastGoodAt: rt.lastGoodAt,
          game: rt.game,
          homeAbbr: rt.game ? rt.game.homeAbbr || abbreviate(rt.game.homeTeam) : '',
          awayAbbr: rt.game ? rt.game.awayAbbr || abbreviate(rt.game.awayTeam) : ''
        };
      }),
      ladder: this.ladderRows,
      log: this.log,
      running: !!this.timer,
      lastTickAt: this.lastTickAt,
      now: Date.now()
    };
  }

  push(events = []) {
    this.emit('state', this.snapshot(), events);
  }

  shutdown() {
    this.stopTimer();
    browserPool.destroyAll();
  }
}

/** Manual and test slots stand alone; every real feed needs a link. */
function needsUrl(slot) {
  return !slot.manualMode && slot.type !== 'test' && slot.type !== 'demo';
}

/** A source only counts as connected if we can see enough to treat it as a game. */
function validateGame(game) {
  if (!game) return { ok: false, error: 'No data returned' };
  if (!game.homeTeam || !game.awayTeam) return { ok: false, error: 'Could not identify both teams' };
  if (game.homeTeam === game.awayTeam) return { ok: false, error: 'Both sides resolved to the same team' };
  const scores = [game.homeScore, game.awayScore, game.homeGoals, game.awayGoals];
  if (scores.some((n) => !Number.isFinite(n) || n < 0)) {
    return { ok: false, error: 'Could not read a valid score' };
  }
  if (!Object.values(STATUS).includes(game.status)) {
    return { ok: false, error: 'Could not read the match status' };
  }
  return { ok: true };
}

module.exports = { GameStore, HEALTH };
