'use strict';

/**
 * End-to-end check against the real scoring feeds, with no window.
 *
 * Builds the actual GameStore, connects the real Record2020 and Scorebug
 * sources, runs a few poll cycles and prints what the LIVE screen would show.
 * Uses its own config profile so game-day settings are never touched.
 *
 * Run with:  npm run livecheck
 */

const path = require('path');
const { app } = require('electron');

const RECORD2020 = process.env.LL_RECORD_URL
  || 'https://record2020.gameface.cc/livescore/c6k-FFG6SUyhOmwbAt_cow';
const SCOREBUG = process.env.LL_SCOREBUG_URL || 'https://afl-scorebug.onrender.com/';

app.disableHardwareAcceleration();
app.setPath('userData', path.join(app.getPath('userData'), 'livecheck'));

const store = require('../main/lib/store');
const { GameStore } = require('../main/engine/gameStore');
const { parseLadder } = require('../main/engine/ladderParser');
const { SAMPLE_LADDER } = require('../main/adapters/demo');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printSlots(games) {
  const snap = games.snapshot();
  for (const s of snap.slots) {
    if (!s.enabled && s.health === 'idle') continue;
    const g = s.game;
    const map = `${s.mapping.home || '—'} / ${s.mapping.away || '—'}`;
    console.log(
      `  ${s.label.padEnd(7)} ${String(s.health).padEnd(10)} ${(s.via || '').padEnd(7)} ` +
      (g
        ? `${g.homeTeam} ${g.homeGoals}.${g.homeBehinds} ${String(g.homeScore).padStart(3)} v ` +
          `${g.awayTeam} ${g.awayGoals}.${g.awayBehinds} ${String(g.awayScore).padStart(3)}  ` +
          `[${g.periodLabel}${g.clock ? ` ${g.clock}` : ''}]  map: ${map}`
        : `(no data) ${s.lastError || ''}`)
    );
  }
  return snap;
}

app.whenReady().then(async () => {
  try {
    store.update((cfg) => {
      cfg.slots[0].type = 'record2020';
      cfg.slots[0].url = RECORD2020;
      cfg.slots[0].manualMode = false;
      cfg.slots[0].mapping = { home: null, away: null };
      cfg.slots[1].type = 'scorebug';
      cfg.slots[1].url = SCOREBUG;
      cfg.slots[1].manualMode = false;
      cfg.slots[1].mapping = { home: null, away: null };
      for (const s of cfg.slots.slice(2)) { s.url = ''; s.type = 'record2020'; s.manualMode = false; }
      cfg.settings.pollInterval = 4000;
      cfg.settings.roundLabel = 'LIVE CHECK';
    });

    const games = new GameStore(store);
    const { clubs } = parseLadder(SAMPLE_LADDER);
    games.setLadder(clubs, SAMPLE_LADDER);

    console.log('\nConnecting real sources…');
    const results = await games.connectAll();
    for (const r of results) {
      console.log(`  ${r.label}: ${r.ok ? 'OK' : `FAILED — ${r.error}`}`);
    }

    console.log('\nAfter connect:');
    printSlots(games);

    games.ensureTimer();
    for (let i = 1; i <= 2; i += 1) {
      await sleep(5000);
      console.log(`\nPoll cycle ${i}:`);
      printSlots(games);
    }

    const snap = games.snapshot();
    console.log('\nLive ladder (top 6):');
    for (const r of snap.ladder.slice(0, 6)) {
      const move = r.delta > 0 ? `+${r.delta}` : r.delta < 0 ? `${r.delta}` : '  ';
      console.log(
        `  ${String(r.position).padStart(2)} ${move.padStart(3)}  ${r.display.padEnd(20)} ` +
        `P${String(r.played).padStart(3)}  PTS ${String(r.pts).padStart(3)}  ${r.pct.toFixed(2).padStart(7)}%` +
        (r.live ? `   LIVE v ${r.opponent} ${r.margin > 0 ? '+' : ''}${r.margin}` : '')
      );
    }

    const unmapped = snap.slots.filter((s) => s.enabled && (!s.mapping.home || !s.mapping.away));
    if (unmapped.length) {
      console.log('\nUnmapped (expected for clubs outside this ladder):');
      for (const s of unmapped) console.log(`  ${s.label}: ${s.game?.homeTeam} v ${s.game?.awayTeam}`);
    }

    console.log('\nBackground browser windows opened:', require('../main/lib/browserPool').activeCount());
    games.shutdown();
    app.exit(0);
  } catch (err) {
    console.error('livecheck failed:', err);
    app.exit(1);
  }
});
