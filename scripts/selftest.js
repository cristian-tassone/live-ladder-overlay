'use strict';

/**
 * Headless check of the pure engine layers — parser, matcher, ladder maths,
 * event detection — plus a live read from both real sources.
 *
 * Run with:  npm run selftest
 */

const { parseLadder } = require('../main/engine/ladderParser');
const { computeLadder } = require('../main/engine/ladder');
const { matchClub } = require('../main/engine/teams');
const { EventDetector } = require('../main/engine/events');
const { makeGame } = require('../main/lib/model');
const record2020 = require('../main/adapters/record2020');
const scorebug = require('../main/adapters/scorebug');

const PASTE = `#\tTeam
1\tChelsea FNC Senior Men
2\tSomerville FNC Senior Men
3\tRed Hill FNC Senior Men
4\tSeaford FNC Senior Men
5\tFrankston Bombers FNC Senior Men
6\tPearcedale FNC Senior Men
7\tRye FNC Senior Men
8\tBonbeach FNC Senior Men
9\tCrib Point FNC Senior Men
10\tHastings FNC Senior Men
11\tKaringal FNC Senior Men
12\tTyabb FNC Senior Men

P\tPTS\t%\tW\tL\tD\tBYE\tF\tA\tFORF\tDISQ\tADJ
18\t60\t176.62\t15\t3\t0\t0\t2017\t1142\t0\t0\t0
18\t56\t151.45\t14\t4\t0\t0\t1669\t1102\t0\t0\t0
18\t52\t147.21\t13\t5\t0\t0\t1531\t1040\t0\t0\t0
18\t52\t140.13\t13\t5\t0\t0\t1662\t1186\t0\t0\t0
18\t48\t152.85\t12\t6\t0\t0\t1663\t1088\t0\t0\t0
18\t48\t118.71\t12\t6\t0\t0\t1542\t1299\t0\t0\t0
18\t40\t84.52\t10\t8\t0\t0\t1223\t1447\t0\t0\t0
18\t28\t93.80\t7\t11\t0\t0\t1332\t1420\t0\t0\t0
18\t20\t87.31\t5\t13\t0\t0\t1252\t1434\t0\t0\t0
18\t20\t75.35\t5\t13\t0\t0\t1134\t1505\t0\t0\t0
18\t8\t49.24\t2\t16\t0\t0\t880\t1787\t0\t0\t0
18\t0\t34.37\t0\t18\t0\t0\t762\t2217\t0\t0\t0`;

let failures = 0;
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(name) {
  console.log(`\n${name}`);
}

(async () => {
  /* ------------------------------ parser ------------------------------ */
  section('Ladder parse');
  const { clubs, warnings } = parseLadder(PASTE);
  check('12 clubs parsed', clubs.length === 12, `${clubs.length}`);
  check('order preserved', clubs[0].name.startsWith('Chelsea') && clubs[11].name.startsWith('Tyabb'));
  check('Chelsea F/A read', clubs[0].pf === 2017 && clubs[0].pa === 1142, `${clubs[0].pf}/${clubs[0].pa}`);
  check('Chelsea points read', clubs[0].pts === 60, String(clubs[0].pts));
  check('no percentage mismatches', warnings.length === 0, warnings.join(' | ') || 'none');

  /* ------------------------------ matching ------------------------------ */
  section('Club matching');
  const list = clubs.map((c) => ({ key: c.key, name: c.name }));
  check('"Bonbeach" -> Bonbeach', matchClub('Bonbeach', list)?.key === clubs[7].key);
  check('"Seaford" -> Seaford', matchClub('Seaford', list)?.key === clubs[3].key);
  check('"FRANKSTON BOMBERS" -> Frankston Bombers', matchClub('FRANKSTON BOMBERS', list)?.key === clubs[4].key);
  check('"Red Hill FNC" -> Red Hill', matchClub('Red Hill FNC', list)?.key === clubs[2].key);
  check('unknown club is unmatched', matchClub('Frankston YCW', list) === null,
    String(matchClub('Frankston YCW', list)?.key));

  /* ------------------------------ ladder ------------------------------ */
  section('Ladder maths');
  const key = (i) => clubs[i].key;

  // Bonbeach (8th, 28pts) beating Chelsea (1st, 60pts) must not move Chelsea off top.
  const base = computeLadder(clubs, []);
  check('no games = unchanged order', base.rows.every((r) => r.position === r.startPosition));
  check('percentage recomputed from F/A', Math.abs(base.rows[0].pct - 176.62) < 0.01, base.rows[0].pct.toFixed(2));

  // Karingal (11th, 8pts) v Crib Point (9th, 20pts): a Karingal win closes to 12.
  const game1 = makeGame({
    homeTeam: 'Karingal', awayTeam: 'Crib Point',
    homeGoals: 12, homeBehinds: 8, awayGoals: 5, awayBehinds: 5, status: 'LIVE', quarter: 4
  });
  const withGame = computeLadder(clubs, [{ id: 'g1', game: game1, homeKey: key(10), awayKey: key(8) }]);
  const kar = withGame.rows.find((r) => r.key === key(10));
  const crib = withGame.rows.find((r) => r.key === key(8));
  check('winner gains 4 points', kar.pts === 12, String(kar.pts));
  check('loser gains none', crib.pts === 20, String(crib.pts));
  check('points for/against applied', kar.pf === 880 + 80 && kar.pa === 1787 + 35, `${kar.pf}/${kar.pa}`);
  check('winner marked live with margin', kar.live && kar.margin === 45, String(kar.margin));

  // A pre-game 0-0 must not hand out draw points.
  const pre = makeGame({ homeTeam: 'Rye', awayTeam: 'Tyabb', status: 'PRE' });
  const withPre = computeLadder(clubs, [{ id: 'g2', game: pre, homeKey: key(6), awayKey: key(11) }]);
  check('pre-game does not award points',
    withPre.rows.find((r) => r.key === key(6)).pts === 40 &&
    withPre.rows.find((r) => r.key === key(11)).pts === 0);

  // Somerville (2nd, 56) losing while Red Hill and Seaford (52) both win = 2nd drops.
  const upset = [
    { id: 'a', game: makeGame({ homeTeam: 'Somerville', awayTeam: 'Rye', homeGoals: 4, homeBehinds: 2, awayGoals: 15, awayBehinds: 10, status: 'LIVE' }), homeKey: key(1), awayKey: key(6) },
    { id: 'b', game: makeGame({ homeTeam: 'Red Hill', awayTeam: 'Tyabb', homeGoals: 20, homeBehinds: 10, awayGoals: 3, awayBehinds: 3, status: 'LIVE' }), homeKey: key(2), awayKey: key(11) },
    { id: 'c', game: makeGame({ homeTeam: 'Seaford', awayTeam: 'Karingal', homeGoals: 18, homeBehinds: 8, awayGoals: 6, awayBehinds: 4, status: 'LIVE' }), homeKey: key(3), awayKey: key(10) }
  ];
  const shaken = computeLadder(clubs, upset);
  const somerville = shaken.rows.find((r) => r.key === key(1));
  check('losing 2nd is passed by two winners', somerville.position === 4, `now ${somerville.position}`);
  check('delta reports the drop', somerville.delta === -2, String(somerville.delta));
  check('rows stay ordered by points then %',
    shaken.rows.every((r, i, a) => i === 0 || a[i - 1].pts > r.pts || (a[i - 1].pts === r.pts && a[i - 1].pct >= r.pct)));

  /* ------------------------------ events ------------------------------ */
  section('Event detection');
  const det = new EventDetector();
  check('first ladder seen fires nothing', det.diffLadder(base.rows).length === 0);
  const moves = det.diffLadder(shaken.rows);
  check('position changes produce events', moves.length > 0, `${moves.length} events`);
  check('repeat of same move is suppressed', det.diffLadder(base.rows).length > 0 && det.diffLadder(shaken.rows).length === 0);

  const g0 = makeGame({ homeTeam: 'A', awayTeam: 'B', homeGoals: 3, homeBehinds: 2, awayGoals: 2, awayBehinds: 1, status: 'LIVE' });
  const g1 = makeGame({ homeTeam: 'A', awayTeam: 'B', homeGoals: 4, homeBehinds: 2, awayGoals: 2, awayBehinds: 1, status: 'LIVE' });
  const g1b = makeGame({ homeTeam: 'A', awayTeam: 'B', homeGoals: 4, homeBehinds: 3, awayGoals: 2, awayBehinds: 1, status: 'LIVE' });
  check('first sample never fires a goal', det.diffGame('s1', g0, 'GAME 1').length === 0);
  const goals = det.diffGame('s1', g1, 'GAME 1');
  check('a goal fires one event', goals.length === 1 && goals[0].type === 'goal' && goals[0].side === 'home');
  check('a behind fires nothing', det.diffGame('s1', g1b, 'GAME 1').length === 0);
  det.forgetGame('s1');
  check('reconnect is not read as scoring', det.diffGame('s1', g1b, 'GAME 1').length === 0);

  /* --------------------------- live sources --------------------------- */
  section('Live source reads');
  try {
    const r = await record2020.read({
      id: 'test-r2020',
      url: 'https://record2020.gameface.cc/livescore/c6k-FFG6SUyhOmwbAt_cow'
    });
    const g = r.game;
    check('record2020 read', !!g.homeTeam && !!g.awayTeam,
      `${g.homeTeam} ${g.homeGoals}.${g.homeBehinds} ${g.homeScore} v ${g.awayTeam} ${g.awayGoals}.${g.awayBehinds} ${g.awayScore} — ${g.periodLabel} (${r.via})`);
    check('record2020 totals add up',
      g.homeScore === g.homeGoals * 6 + g.homeBehinds && g.awayScore === g.awayGoals * 6 + g.awayBehinds);
  } catch (err) {
    check('record2020 read', false, err.message);
  }

  try {
    const r = await scorebug.read({ id: 'test-scorebug', url: 'https://afl-scorebug.onrender.com/' });
    const g = r.game;
    check('scorebug read', !!g.homeTeam && !!g.awayTeam,
      `${g.homeTeam} ${g.homeScore} v ${g.awayTeam} ${g.awayScore} — ${g.periodLabel}${g.clock ? ` ${g.clock}` : ''} (${r.via})`);
  } catch (err) {
    check('scorebug read', false, err.message);
  }

  console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'All checks passed'}\n`);
  process.exit(failures ? 1 : 0);
})();
