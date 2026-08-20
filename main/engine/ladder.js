'use strict';

/**
 * Ladder engine — pure functions, no UI, no I/O.
 *
 * Inputs : the ladder entering the round + the current normalised games
 * Output : the live ladder, ordered
 *
 * Rules (standard AFL): 4 points a win, 2 a draw, 0 a loss.
 * Percentage = points for / points against x 100.
 * Ordered by premiership points, then percentage, then points for.
 *
 * A game only affects the ladder once it has started. A scheduled game sitting
 * at 0-0 is deliberately excluded: projecting it as a draw would hand both
 * clubs two points they have not played for.
 */

const { STATUS } = require('../lib/model');

function pct(pf, pa) {
  if (!pa) return pf > 0 ? Infinity : 0;
  return (pf / pa) * 100;
}

function compareRows(a, b) {
  if (b.pts !== a.pts) return b.pts - a.pts;
  const pa = a.pct === Infinity ? Number.MAX_VALUE : a.pct;
  const pb = b.pct === Infinity ? Number.MAX_VALUE : b.pct;
  if (pb !== pa) return pb - pa;
  if (b.pf !== a.pf) return b.pf - a.pf;
  return a.name.localeCompare(b.name);
}

/** Games that should be reflected in the live ladder. */
function countsTowardLadder(game) {
  if (!game) return false;
  return game.status === STATUS.LIVE || game.status === STATUS.BREAK || game.status === STATUS.FINAL;
}

/**
 * @param {Array} clubs        starting ladder (from ladderParser)
 * @param {Array} liveGames    [{ id, game, homeKey, awayKey }]
 * @returns {{rows:Array, mappedGames:number}}
 */
function computeLadder(clubs, liveGames) {
  const rows = new Map();

  for (const c of clubs) {
    rows.set(c.key, {
      key: c.key,
      name: c.name,
      display: c.display || c.name,
      played: c.played,
      w: c.w,
      l: c.l,
      d: c.d,
      byes: c.byes || 0,
      pf: c.pf,
      pa: c.pa,
      pts: c.pts,
      startPosition: c.startPosition,
      // live context
      live: false,
      gameId: null,
      opponent: null,
      margin: 0,
      liveResult: null, // 'W' | 'L' | 'D'
      startPts: c.pts,
      startPct: pct(c.pf, c.pa)
    });
  }

  let mappedGames = 0;

  for (const lg of liveGames) {
    const { game, homeKey, awayKey } = lg;
    if (!countsTowardLadder(game)) continue;
    const home = homeKey ? rows.get(homeKey) : null;
    const away = awayKey ? rows.get(awayKey) : null;
    if (!home && !away) continue;
    mappedGames += 1;

    const hs = game.homeScore;
    const as = game.awayScore;

    const applyTo = (row, own, opp, oppName) => {
      if (!row) return;
      row.live = true;
      row.gameId = lg.id;
      row.opponent = oppName;
      row.margin = own - opp;
      row.played += 1;
      row.pf += own;
      row.pa += opp;
      if (own > opp) { row.w += 1; row.pts += 4; row.liveResult = 'W'; }
      else if (own < opp) { row.l += 1; row.liveResult = 'L'; }
      else { row.d += 1; row.pts += 2; row.liveResult = 'D'; }
    };

    applyTo(home, hs, as, away ? away.display : game.awayTeam);
    applyTo(away, as, hs, home ? home.display : game.homeTeam);
  }

  const list = [...rows.values()];
  for (const r of list) r.pct = pct(r.pf, r.pa);
  list.sort(compareRows);
  list.forEach((r, i) => {
    r.position = i + 1;
    r.delta = r.startPosition - r.position; // + = climbed
  });

  return { rows: list, mappedGames };
}

module.exports = { computeLadder, pct, compareRows, countsTowardLadder };
