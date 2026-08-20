'use strict';

/**
 * Persistence — a single JSON document in Electron's userData folder.
 * Written atomically so a crash mid-save cannot leave an unreadable config.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'live-ladder.json');

function defaultSlot(i) {
  return {
    id: `game-${i + 1}`,
    label: `GAME ${i + 1}`,
    type: 'record2020',
    url: '',
    enabled: false,
    manualMode: false,
    manual: {
      homeTeam: '',
      awayTeam: '',
      homeGoals: 0,
      homeBehinds: 0,
      awayGoals: 0,
      awayBehinds: 0,
      quarter: 1,
      clock: '',
      status: 'LIVE'
    },
    mapping: { home: null, away: null }
  };
}

function defaults() {
  return {
    version: 1,
    settings: {
      pollInterval: 5000,
      staleAfter: 30000,
      reconnectOnStart: false,
      roundLabel: '',
      compLabel: ''
    },
    ladder: { clubs: [], raw: '', updatedAt: null },
    slots: Array.from({ length: 5 }, (_, i) => defaultSlot(i))
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = { ...defaults(), ...parsed };
    cache.settings = { ...defaults().settings, ...(parsed.settings || {}) };
    cache.ladder = { ...defaults().ladder, ...(parsed.ladder || {}) };
    // Guarantee five well-formed slots even if the file is old or hand-edited.
    const base = defaults().slots;
    cache.slots = base.map((d, i) => {
      const s = (parsed.slots || [])[i] || {};
      return { ...d, ...s, manual: { ...d.manual, ...(s.manual || {}) }, mapping: { ...d.mapping, ...(s.mapping || {}) } };
    });
  } catch {
    cache = defaults();
  }
  return cache;
}

function save(next) {
  cache = next || cache;
  const file = FILE();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[store] save failed:', err.message);
  }
  return cache;
}

function update(mutator) {
  const cfg = load();
  mutator(cfg);
  return save(cfg);
}

module.exports = { load, save, update, defaults, defaultSlot, FILE };
