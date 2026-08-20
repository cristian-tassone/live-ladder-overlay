'use strict';

/**
 * Custom Scorebug adapter (afl-scorebug.onrender.com and any deployment of it).
 *
 * The scorebug exposes its whole state as JSON at GET <origin>/state — confirmed
 * against the live deployment — so no browser is required:
 *
 *   { homeAbbr, awayAbbr, homeName, awayName,
 *     homeGoals, homeBehinds, homeTotal, awayGoals, awayBehinds, awayTotal,
 *     gameState, timerSecs, timerRunning, ... }
 *
 * DOM reading through offscreen Chromium is kept as a fallback for deployments
 * that only render the bug.
 */

const { getJson } = require('../lib/http');
const browserPool = require('../lib/browserPool');
const { makeGame, STATUS, formatClock } = require('../lib/model');

function canHandle(rawUrl) {
  return /scorebug/i.test(String(rawUrl || ''));
}

function parseUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('That does not look like a valid URL');
  }
  return { origin: url.origin, stateUrl: `${url.origin}/state` };
}

/** Map the scorebug's free-text game state onto the shared status model. */
function mapState(raw, timerRunning) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');

  const q = s.match(/^Q\s*([1-4])$/) || s.match(/^([1-4])(?:ST|ND|RD|TH)$/);
  if (q) return { quarter: +q[1], status: STATUS.LIVE, label: `Q${q[1]}` };

  if (/^(PRE ?GAME|PRE|WARM ?UP|UPCOMING)$/.test(s)) {
    return { quarter: 0, status: STATUS.PRE, label: 'PRE GAME' };
  }
  if (/(FULL ?TIME|FINAL|FT)/.test(s)) {
    return { quarter: 4, status: STATUS.FINAL, label: 'FINAL' };
  }
  if (/(3 ?QTR|3 ?QUARTER|THREE ?QUARTER|3\/4)/.test(s)) {
    return { quarter: 3, status: STATUS.BREAK, label: '3QTR TIME' };
  }
  if (/(HALF)/.test(s)) {
    return { quarter: 2, status: STATUS.BREAK, label: 'HALF TIME' };
  }
  if (/(QTR ?TIME|QUARTER ?TIME|1\/4)/.test(s)) {
    return { quarter: 1, status: STATUS.BREAK, label: 'QTR TIME' };
  }
  if (/(EXTRA ?TIME|ET)/.test(s)) {
    return { quarter: 5, status: STATUS.LIVE, label: 'EXTRA TIME' };
  }

  return {
    quarter: 0,
    status: timerRunning ? STATUS.LIVE : STATUS.PRE,
    label: s || 'LIVE'
  };
}

async function readViaApi(rawUrl) {
  const { stateUrl } = parseUrl(rawUrl);
  const s = await getJson(stateUrl, { timeout: 10000 });
  if (!s || typeof s !== 'object' || s.homeGoals === undefined) {
    throw new Error('Scorebug state endpoint returned an unexpected payload');
  }

  const mapped = mapState(s.gameState, s.timerRunning);

  return makeGame({
    sourceType: 'scorebug',
    sourceUrl: rawUrl,
    homeTeam: s.homeName || s.homeAbbr || 'HOME',
    awayTeam: s.awayName || s.awayAbbr || 'AWAY',
    homeAbbr: s.homeAbbr || '',
    awayAbbr: s.awayAbbr || '',
    homeGoals: s.homeGoals,
    homeBehinds: s.homeBehinds,
    homeScore: s.homeTotal,
    awayGoals: s.awayGoals,
    awayBehinds: s.awayBehinds,
    awayScore: s.awayTotal,
    quarter: mapped.quarter,
    periodLabel: mapped.label,
    clock: formatClock(s.timerSecs),
    status: mapped.status,
    venue: s.flexText || ''
  });
}

// Element ids taken from the live scorebug markup.
const DOM_SCRIPT = `(() => {
  const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
  const n = (id) => { const v = t(id); return /^-?\\d+$/.test(v) ? +v : 0; };
  return {
    homeName: t('cpp-home-name') || t('home-abbr-display'),
    awayName: t('cpp-away-name') || t('away-abbr-display'),
    homeAbbr: t('home-abbr-display'),
    awayAbbr: t('away-abbr-display'),
    hg: n('hg'), hb: n('hb'), ht: n('ht'),
    ag: n('ag'), ab: n('ab'), at: n('at'),
    quarter: t('quarter-display'),
    status: t('status-display'),
    timer: t('timer-display')
  };
})()`;

async function readViaBrowser(key, rawUrl) {
  const d = await browserPool.evaluate(key, rawUrl, DOM_SCRIPT);
  if (!d || (!d.homeAbbr && !d.homeName)) throw new Error('Could not read the rendered scorebug');
  const mapped = mapState(d.status && d.status !== '' ? d.status : d.quarter, true);
  return makeGame({
    sourceType: 'scorebug',
    sourceUrl: rawUrl,
    homeTeam: d.homeName || d.homeAbbr,
    awayTeam: d.awayName || d.awayAbbr,
    homeAbbr: d.homeAbbr,
    awayAbbr: d.awayAbbr,
    homeGoals: d.hg,
    homeBehinds: d.hb,
    homeScore: d.ht,
    awayGoals: d.ag,
    awayBehinds: d.ab,
    awayScore: d.at,
    quarter: mapped.quarter,
    periodLabel: mapped.label,
    clock: d.timer || null,
    status: mapped.status
  });
}

async function read(cfg) {
  try {
    const game = await readViaApi(cfg.url);
    browserPool.destroy(cfg.id);
    return { game, via: 'api' };
  } catch (apiErr) {
    try {
      const game = await readViaBrowser(cfg.id, cfg.url);
      return { game, via: 'browser', warning: `State read failed (${apiErr.message}) — using page render` };
    } catch (domErr) {
      const err = new Error(apiErr.message || domErr.message);
      err.detail = `api: ${apiErr.message} | dom: ${domErr.message}`;
      throw err;
    }
  }
}

module.exports = {
  id: 'scorebug',
  label: 'Custom Scorebug',
  placeholder: 'https://afl-scorebug.onrender.com/',
  canHandle,
  parseUrl,
  read
};
