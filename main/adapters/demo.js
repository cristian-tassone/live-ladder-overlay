'use strict';

/**
 * Test adapter — a simulated round for rehearsal and for checking the LIVE
 * screen out of season.
 *
 * It is deliberately explicit: a slot on this source is labelled TEST in the
 * UI and reads nothing from the network. It exists so an operator can practise
 * the game-day flow, and so ladder movement can be exercised without waiting
 * for a real Saturday.
 */

const { makeGame, STATUS, formatClock } = require('../lib/model');

const FIXTURES = [
  ['Devon Meadows', 'Dromana'],
  ['Rosebud', 'Langwarrin'],
  ['Mt. Eliza', 'Frankston YCW'],
  ['Edithvale-Aspendale', 'Mornington'],
  ['Sorrento', 'Pines']
];

const QUARTER_SECONDS = 25 * 60;
const SPEED = 90; // simulated seconds per real second

/** @type {Map<string, object>} */
const games = new Map();

function seedFor(id) {
  if (games.has(id)) return games.get(id);
  const index = games.size % FIXTURES.length;
  const [home, away] = FIXTURES[index];
  const state = {
    home,
    away,
    startedAt: Date.now(),
    homeGoals: 0,
    homeBehinds: 0,
    awayGoals: 0,
    awayBehinds: 0,
    lastScoreAt: Date.now(),
    // Give each fixture its own scoring rhythm so the ladder actually churns.
    homeRate: 0.55 + (index % 3) * 0.14,
    awayRate: 0.5 + ((index + 1) % 3) * 0.16
  };
  games.set(id, state);
  return state;
}

function advance(state) {
  const now = Date.now();
  const elapsed = (now - state.lastScoreAt) / 1000;
  if (elapsed < 1.5) return;
  state.lastScoreAt = now;

  const roll = (rate) => {
    const r = Math.random();
    if (r < rate * 0.20) return 'goal';
    if (r < rate * 0.42) return 'behind';
    return null;
  };

  const h = roll(state.homeRate);
  if (h === 'goal') state.homeGoals += 1;
  if (h === 'behind') state.homeBehinds += 1;

  const a = roll(state.awayRate);
  if (a === 'goal') state.awayGoals += 1;
  if (a === 'behind') state.awayBehinds += 1;
}

async function read(cfg) {
  const state = seedFor(cfg.id);
  advance(state);

  const simSeconds = ((Date.now() - state.startedAt) / 1000) * SPEED;
  const quarterIndex = Math.floor(simSeconds / QUARTER_SECONDS);
  const intoQuarter = simSeconds % QUARTER_SECONDS;

  let status = STATUS.LIVE;
  let quarter = Math.min(4, quarterIndex + 1);
  let label = `Q${quarter}`;

  if (quarterIndex >= 4) {
    status = STATUS.FINAL;
    quarter = 4;
    label = 'FINAL';
  }

  return {
    via: 'demo',
    game: makeGame({
      sourceType: 'test',
      sourceUrl: '',
      homeTeam: state.home,
      awayTeam: state.away,
      homeGoals: state.homeGoals,
      homeBehinds: state.homeBehinds,
      awayGoals: state.awayGoals,
      awayBehinds: state.awayBehinds,
      quarter,
      periodLabel: label,
      clock: status === STATUS.FINAL ? null : formatClock(QUARTER_SECONDS - intoQuarter),
      status
    })
  };
}

/** Current rehearsal ladder, used to seed demo mode with the upcoming round. */
const SAMPLE_LADDER = [
  '#\tTeam',
  '1\tRosebud FNC Senior Men',
  '2\tLangwarrin FNC Senior Men',
  '3\tMt. Eliza FNC Senior Men',
  '4\tDromana FNC Senior Men',
  '5\tFrankston YCW FNC Senior Men',
  '6\tDevon Meadows FNC Senior Men',
  '7\tEdithvale-Aspendale FNC Senior Men',
  '8\tMornington FNC Senior Men',
  '9\tSorrento FNC Senior Men',
  '10\tPines FNC Senior Men',
  '',
  'P\tPTS\t%\tW\tL\tD\tBYE\tF\tA\tFORF\tDISQ\tADJ',
  '17\t60\t149.17\t15\t2\t0\t0\t1699\t1139\t0\t0\t0',
  '17\t56\t154.59\t14\t3\t0\t0\t1736\t1123\t0\t0\t0',
  '17\t36\t113.89\t9\t8\t0\t0\t1320\t1159\t0\t0\t0',
  '17\t36\t111.49\t9\t8\t0\t0\t1524\t1367\t0\t0\t0',
  '17\t36\t100.08\t9\t8\t0\t0\t1263\t1262\t0\t0\t0',
  '17\t36\t89.44\t9\t8\t0\t0\t1338\t1496\t0\t0\t0',
  '17\t32\t101.42\t8\t9\t0\t0\t1495\t1474\t0\t0\t0',
  '17\t24\t81.41\t6\t11\t0\t0\t1384\t1700\t0\t0\t0',
  '17\t16\t73.76\t4\t13\t0\t0\t1338\t1814\t0\t0\t0',
  '17\t8\t66.35\t2\t15\t0\t0\t1110\t1673\t0\t0\t0'
].join('\n');

module.exports = {
  SAMPLE_LADDER,
  id: 'test',
  label: 'Test — live simulation',
  placeholder: 'No link needed — this slot simulates a game',
  canHandle: () => false,
  read
};
