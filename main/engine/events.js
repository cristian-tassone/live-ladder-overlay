'use strict';

/**
 * Event detection.
 *
 * Compares explicitly held previous state against new state. Nothing here is
 * inferred from what the UI happens to render.
 *
 * Hierarchy, per the brief:
 *   goal            -> local game-card animation only
 *   position change -> major application event: animation + highlight + log
 *   percentage move -> silent
 */

const { STATUS } = require('../lib/model');

// A club sitting on a percentage boundary can flip position repeatedly. Swallow
// a repeat of the same move within this window so the log stays readable.
const REPEAT_WINDOW_MS = 25000;

class EventDetector {
  constructor() {
    /** @type {Map<string, {position:number, pts:number}>} */
    this.prevLadder = new Map();
    /** @type {Map<string, {homeGoals:number, awayGoals:number, homeScore:number, awayScore:number, status:string, established:boolean, leader:string, quarter:number, notedMargin:number}>} */
    this.prevGames = new Map();
    /** @type {Map<string, number>} */
    this.recentMoves = new Map();
    this.seededLadder = false;
    this.seq = 0;
  }

  reset() {
    this.prevLadder.clear();
    this.prevGames.clear();
    this.recentMoves.clear();
    this.seededLadder = false;
  }

  /** Forget one game's history, e.g. on disconnect, so a reconnect can't fake a goal. */
  forgetGame(id) {
    this.prevGames.delete(id);
  }

  makeEvent(type, payload) {
    this.seq += 1;
    return {
      id: `${Date.now()}-${this.seq}`,
      type,
      at: new Date().toISOString(),
      ...payload
    };
  }

  /**
   * Detect goals and match-state changes for one game.
   * The first sample after connecting only seeds state — it never fires a goal.
   */
  diffGame(slotId, game, label) {
    const events = [];
    if (!game) return events;

    const prev = this.prevGames.get(slotId);
    const leader = game.homeScore > game.awayScore ? 'home'
      : game.awayScore > game.homeScore ? 'away' : 'draw';
    const margin = Math.abs(game.homeScore - game.awayScore);
    const next = {
      homeGoals: game.homeGoals,
      awayGoals: game.awayGoals,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      status: game.status,
      established: true,
      leader,
      quarter: game.quarter || 0,
      runSide: prev ? prev.runSide : null,
      runGoals: prev ? prev.runGoals : 0
    };

    if (prev && prev.established) {
      const homeDelta = game.homeGoals - prev.homeGoals;
      const awayDelta = game.awayGoals - prev.awayGoals;
      const hName = prettyTeam(game.homeTeam);
      const aName = prettyTeam(game.awayTeam);
      const leadName = leader === 'home' ? hName : aName;

      const updateRun = (side, count, teamName) => {
        const before = next.runSide === side ? next.runGoals : 0;
        next.runSide = side;
        next.runGoals = before + count;
        if (next.runGoals >= 4 && before < 4) {
          events.push(this.makeEvent('note', {
            slotId, gameLabel: label,
            kind: 'run',
            text: `${teamName} on a run — ${next.runGoals} straight goals`
          }));
        }
      };

      if (homeDelta > 0) {
        events.push(
          this.makeEvent('goal', {
            slotId,
            side: 'home',
            team: game.homeTeam,
            count: homeDelta,
            score: `${game.homeScore}-${game.awayScore}`,
            gameLabel: label
          })
        );
        updateRun('home', homeDelta, hName);
      }
      if (awayDelta > 0) {
        events.push(
          this.makeEvent('goal', {
            slotId,
            side: 'away',
            team: game.awayTeam,
            count: awayDelta,
            score: `${game.homeScore}-${game.awayScore}`,
            gameLabel: label
          })
        );
        updateRun('away', awayDelta, aName);
      }

      // Lead changes only become useful once both teams have passed 30 points.
      if (prev.leader !== leader && leader !== 'draw' && prev.leader !== 'draw'
          && game.homeScore > 30 && game.awayScore > 30) {
        events.push(this.makeEvent('note', {
          slotId, gameLabel: label,
          kind: 'lead',
          text: `${leadName} hit the front against ${leader === 'home' ? aName : hName}`
        }));
      }

      if (prev.status !== game.status && game.status === STATUS.FINAL) {
        const home = `${hName} ${game.homeScore}`;
        const away = `${aName} ${game.awayScore}`;
        events.push(
          this.makeEvent('final', {
            slotId,
            gameLabel: label,
            text: `FULL TIME — ${home} ${
              game.homeScore === game.awayScore ? 'drew with' : game.homeScore > game.awayScore ? 'def' : 'def by'
            } ${away}`
          })
        );
      }
    }

    this.prevGames.set(slotId, next);
    return events;
  }

  /**
   * Detect ladder position changes.
   * The very first ladder seen only seeds state, so opening the app never
   * produces a burst of phantom movement.
   */
  diffLadder(rows) {
    const events = [];
    const now = Date.now();

    if (!this.seededLadder) {
      for (const r of rows) this.prevLadder.set(r.key, { position: r.position, pts: r.pts });
      this.seededLadder = true;
      return events;
    }

    const moved = [];
    for (const r of rows) {
      const prev = this.prevLadder.get(r.key);
      if (!prev) {
        this.prevLadder.set(r.key, { position: r.position, pts: r.pts });
        continue;
      }
      if (prev.position !== r.position) {
        moved.push({ row: r, from: prev.position, to: r.position });
      }
    }

    for (const m of moved) {
      const sig = `${m.row.key}:${m.from}>${m.to}`;
      const last = this.recentMoves.get(sig);
      if (last && now - last < REPEAT_WINDOW_MS) continue;
      this.recentMoves.set(sig, now);

      const label = m.row.display || m.row.name;
      events.push(
        this.makeEvent('position', {
          key: m.row.key,
          team: label,
          from: m.from,
          to: m.to,
          direction: m.to < m.from ? 'up' : 'down',
          jump: Math.abs(m.from - m.to),
          text: describeMove(label, m.from, m.to)
        })
      );
    }

    for (const r of rows) this.prevLadder.set(r.key, { position: r.position, pts: r.pts });

    // Keep the dedupe map from growing forever
    for (const [sig, t] of this.recentMoves) {
      if (now - t > REPEAT_WINDOW_MS * 4) this.recentMoves.delete(sig);
    }

    return events;
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describeMove(name, from, to) {
  const jump = Math.abs(from - to);
  const upper = String(name).toUpperCase();
  if (to < from) {
    return jump >= 2
      ? `${upper} jumps from ${ordinal(from)} to ${ordinal(to)}`
      : `${upper} moves into ${ordinal(to)}`;
  }
  return jump >= 2
    ? `${upper} slides from ${ordinal(from)} to ${ordinal(to)}`
    : `${upper} drops to ${ordinal(to)}`;
}

function prettyTeam(name) {
  return String(name)
    .replace(/\s+(FNC|FC|AFC|JFC)\b/gi, '')
    .replace(/\s+Senior\s+(Men|Women)\b/gi, '')
    .replace(/\s+Football\s+Netball\s+Club\b/gi, '')
    .trim()
    .toUpperCase();
}

module.exports = { EventDetector, ordinal, describeMove };
