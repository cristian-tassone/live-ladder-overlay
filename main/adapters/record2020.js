'use strict';

/**
 * Record2020 / GameFace adapter.
 *
 * The public /livescore/<sharecode> page is an AngularJS app. Rather than
 * guessing at its DOM, this adapter reads the two JSON endpoints the page
 * itself calls (confirmed by inspecting the live page's network traffic):
 *
 *   GET /Api/Fixture/GetFixtureScoreForCode/<sharecode>
 *       -> { IsValid, ReturnValue: { Status, CurrentGameIntervalId,
 *              HomeTeamId, AwayTeamId, GameIntervals: [
 *                { Id, IntervalName, IsPlay, Order,
 *                  HomeScore: {Goals,Behinds}, AwayScore: {Goals,Behinds} } ] } }
 *
 *   GET /Api/Competition/GetSharedTeams/<sharecode>
 *       -> { ReturnValue: [ { Id, Name }, ... ] }
 *
 * Running totals are the sum of the play intervals. No auth, no cookies, no
 * browser required — which makes it far more reliable than DOM scraping.
 *
 * If those endpoints ever change shape, `readViaBrowser` falls back to reading
 * the rendered DOM through the offscreen Chromium pool.
 */

const { getJson } = require('../lib/http');
const browserPool = require('../lib/browserPool');
const { makeGame, STATUS } = require('../lib/model');

const DEFAULT_ORIGIN = 'https://record2020.gameface.cc';

/** Team names rarely change; cache per share code for the session. */
const teamCache = new Map();

function parseUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('That does not look like a valid URL');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  // .../livescore/<code>, .../quarterlylivescore/<code>, or a bare code path
  const code = segments[segments.length - 1] || '';
  if (!code || code.length < 8) {
    throw new Error('Could not find a share code in that Record2020 link');
  }
  return { origin: url.origin || DEFAULT_ORIGIN, code };
}

function canHandle(rawUrl) {
  return /record2020|gameface\.cc/i.test(String(rawUrl || ''));
}

/**
 * Map Record2020's interval naming onto our status model.
 * Play intervals are 1ST/2ND/3RD/4TH; the others are breaks.
 */
function mapInterval(name) {
  const n = String(name || '').trim().toUpperCase();
  switch (n) {
    case '1ST':
      return { quarter: 1, status: STATUS.LIVE, label: 'Q1' };
    case '2ND':
      return { quarter: 2, status: STATUS.LIVE, label: 'Q2' };
    case '3RD':
      return { quarter: 3, status: STATUS.LIVE, label: 'Q3' };
    case '4TH':
      return { quarter: 4, status: STATUS.LIVE, label: 'Q4' };
    case '1/4':
      return { quarter: 1, status: STATUS.BREAK, label: 'QTR TIME' };
    case 'HALF':
      return { quarter: 2, status: STATUS.BREAK, label: 'HALF TIME' };
    case '3/4':
      return { quarter: 3, status: STATUS.BREAK, label: '3QTR TIME' };
    case 'FULL':
      return { quarter: 4, status: STATUS.FINAL, label: 'FINAL' };
    case 'PRE':
    case '':
      return { quarter: 0, status: STATUS.PRE, label: 'PRE GAME' };
    default:
      return { quarter: 0, status: STATUS.LIVE, label: n };
  }
}

async function fetchTeams(origin, code, force = false) {
  const key = `${origin}|${code}`;
  if (!force && teamCache.has(key)) return teamCache.get(key);
  const body = await getJson(`${origin}/Api/Competition/GetSharedTeams/${code}`);
  const list = Array.isArray(body?.ReturnValue) ? body.ReturnValue : [];
  const map = new Map(list.map((t) => [t.Id, String(t.Name || '').trim()]));
  teamCache.set(key, map);
  return map;
}

async function readViaApi(rawUrl) {
  const { origin, code } = parseUrl(rawUrl);

  const body = await getJson(`${origin}/Api/Fixture/GetFixtureScoreForCode/${code}`);
  if (!body || body.IsValid === false || !body.ReturnValue) {
    throw new Error('Record2020 did not return a fixture for that link');
  }
  const fx = body.ReturnValue;

  let teams = await fetchTeams(origin, code);
  if (!teams.has(fx.HomeTeamId) || !teams.has(fx.AwayTeamId)) {
    teams = await fetchTeams(origin, code, true); // team list may have been edited
  }

  const intervals = Array.isArray(fx.GameIntervals) ? fx.GameIntervals : [];
  const play = intervals
    .filter((i) => i.IsPlay)
    .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));

  let hg = 0;
  let hb = 0;
  let ag = 0;
  let ab = 0;
  const periods = play.map((i, idx) => {
    const h = i.HomeScore || { Goals: 0, Behinds: 0 };
    const a = i.AwayScore || { Goals: 0, Behinds: 0 };
    hg += Number(h.Goals) || 0;
    hb += Number(h.Behinds) || 0;
    ag += Number(a.Goals) || 0;
    ab += Number(a.Behinds) || 0;
    return {
      name: `Q${idx + 1}`,
      home: { goals: Number(h.Goals) || 0, behinds: Number(h.Behinds) || 0 },
      away: { goals: Number(a.Goals) || 0, behinds: Number(a.Behinds) || 0 }
    };
  });

  // Prefer the explicitly flagged current interval; fall back to Status text.
  const current = intervals.find((i) => i.Id != null && i.Id === fx.CurrentGameIntervalId);
  const mapped = mapInterval(current ? current.IntervalName : fx.Status);

  // A fixture marked Full is final regardless of which interval is highlighted.
  if (String(fx.Status || '').toUpperCase() === 'FULL') {
    mapped.status = STATUS.FINAL;
    mapped.label = 'FINAL';
    mapped.quarter = 4;
  }

  const noScore = hg + hb + ag + ab === 0;
  if (noScore && mapped.status === STATUS.LIVE && !current) {
    mapped.status = STATUS.PRE;
    mapped.label = 'PRE GAME';
    mapped.quarter = 0;
  }

  return makeGame({
    sourceType: 'record2020',
    sourceUrl: rawUrl,
    homeTeam: teams.get(fx.HomeTeamId) || 'HOME',
    awayTeam: teams.get(fx.AwayTeamId) || 'AWAY',
    homeGoals: hg,
    homeBehinds: hb,
    awayGoals: ag,
    awayBehinds: ab,
    quarter: mapped.quarter,
    periodLabel: mapped.label,
    clock: null, // Record2020 does not publish a game clock
    status: mapped.status,
    periods
  });
}

/* ------------------------------------------------------------------ */
/* Fallback: read the rendered page through offscreen Chromium         */
/* ------------------------------------------------------------------ */

// Evaluated inside the page. Selectors taken from the live markup:
// .club p (team names), .score-updater[team=...] .score-details / .total,
// li.selected-interval a (current period).
const DOM_SCRIPT = `(() => {
  const txt = (el) => (el && el.textContent || '').trim();
  const clubs = [...document.querySelectorAll('.club p')].map(txt);
  const block = (side) => {
    const el = document.querySelector('.score-updater[team="' + side + '"]');
    if (!el) return null;
    const detail = txt(el.querySelector('.score-details'));
    const total = txt(el.querySelector('.total'));
    const m = detail.match(/(\\d+)\\s*\\.\\s*(\\d+)/);
    return {
      goals: m ? +m[1] : 0,
      behinds: m ? +m[2] : 0,
      total: /^\\d+$/.test(total) ? +total : null
    };
  };
  return {
    home: clubs[0] || '',
    away: clubs[1] || '',
    homeScore: block('home'),
    awayScore: block('away'),
    interval: txt(document.querySelector('.selected-interval a')),
    error: txt(document.querySelector('.error, .alert-danger'))
  };
})()`;

async function readViaBrowser(key, rawUrl) {
  const data = await browserPool.evaluate(key, rawUrl, DOM_SCRIPT);
  if (!data || !data.homeScore || !data.awayScore) {
    throw new Error(data && data.error ? data.error : 'Could not read the rendered page');
  }
  const mapped = mapInterval(data.interval);
  return makeGame({
    sourceType: 'record2020',
    sourceUrl: rawUrl,
    homeTeam: data.home || 'HOME',
    awayTeam: data.away || 'AWAY',
    homeGoals: data.homeScore.goals,
    homeBehinds: data.homeScore.behinds,
    homeScore: data.homeScore.total,
    awayGoals: data.awayScore.goals,
    awayBehinds: data.awayScore.behinds,
    awayScore: data.awayScore.total,
    quarter: mapped.quarter,
    periodLabel: mapped.label,
    status: mapped.status
  });
}

/**
 * Read one sample. Tries the JSON API, then the rendered DOM.
 * @param {{id:string, url:string}} cfg
 */
async function read(cfg) {
  try {
    const game = await readViaApi(cfg.url);
    browserPool.destroy(cfg.id); // API is healthy again — release any fallback page
    return { game, via: 'api' };
  } catch (apiErr) {
    try {
      const game = await readViaBrowser(cfg.id, cfg.url);
      return { game, via: 'browser', warning: `API read failed (${apiErr.message}) — using page render` };
    } catch (domErr) {
      const err = new Error(apiErr.message || domErr.message);
      err.detail = `api: ${apiErr.message} | dom: ${domErr.message}`;
      throw err;
    }
  }
}

module.exports = {
  id: 'record2020',
  label: 'Record2020 / GameFace',
  placeholder: 'https://record2020.gameface.cc/livescore/…',
  canHandle,
  parseUrl,
  read
};
