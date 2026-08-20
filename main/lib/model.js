'use strict';

/**
 * The normalised game model.
 *
 * Every source adapter — record2020, scorebug, manual — must return this exact
 * shape. Nothing downstream (game store, ladder engine, UI) is allowed to know
 * where the numbers came from.
 */

const STATUS = {
  PRE: 'PRE',
  LIVE: 'LIVE',
  BREAK: 'BREAK',
  FINAL: 'FINAL'
};

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Build a normalised game object, filling in anything the adapter left out. */
function makeGame(partial = {}) {
  const homeGoals = num(partial.homeGoals);
  const homeBehinds = num(partial.homeBehinds);
  const awayGoals = num(partial.awayGoals);
  const awayBehinds = num(partial.awayBehinds);

  return {
    sourceType: partial.sourceType || 'unknown',
    sourceUrl: partial.sourceUrl || '',

    homeTeam: (partial.homeTeam || '').trim(),
    awayTeam: (partial.awayTeam || '').trim(),
    homeAbbr: (partial.homeAbbr || '').trim(),
    awayAbbr: (partial.awayAbbr || '').trim(),

    homeGoals,
    homeBehinds,
    homeScore: Number.isFinite(Number(partial.homeScore))
      ? num(partial.homeScore)
      : homeGoals * 6 + homeBehinds,

    awayGoals,
    awayBehinds,
    awayScore: Number.isFinite(Number(partial.awayScore))
      ? num(partial.awayScore)
      : awayGoals * 6 + awayBehinds,

    quarter: num(partial.quarter, 0),
    periodLabel: partial.periodLabel || '',
    clock: partial.clock || null,

    status: partial.status || STATUS.PRE,
    periods: Array.isArray(partial.periods) ? partial.periods : [],

    venue: partial.venue || '',
    lastUpdated: partial.lastUpdated || new Date().toISOString()
  };
}

/** Format a seconds count as M:SS / MM:SS for the clock field. */
function formatClock(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(Number(totalSeconds))) return null;
  const s = Math.max(0, Math.floor(Number(totalSeconds)));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/**
 * True when two samples represent the same scoreboard state.
 * Used to avoid firing change events on identical polls.
 */
function sameScore(a, b) {
  if (!a || !b) return false;
  return (
    a.homeGoals === b.homeGoals &&
    a.homeBehinds === b.homeBehinds &&
    a.awayGoals === b.awayGoals &&
    a.awayBehinds === b.awayBehinds &&
    a.status === b.status &&
    a.quarter === b.quarter
  );
}

module.exports = { STATUS, makeGame, formatClock, sameScore, num };
