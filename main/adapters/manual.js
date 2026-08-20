'use strict';

/**
 * Manual adapter — the game-day safety net.
 *
 * Reads nothing from the network; it simply echoes back whatever the operator
 * typed into the manual panel, normalised into the same game object as every
 * live source. The ladder engine cannot tell the difference.
 */

const { makeGame, STATUS } = require('../lib/model');

const LABELS = {
  0: 'PRE GAME',
  1: 'Q1',
  2: 'Q2',
  3: 'Q3',
  4: 'Q4'
};

function labelFor(manual) {
  if (manual.status === STATUS.FINAL) return 'FINAL';
  if (manual.status === STATUS.PRE) return 'PRE GAME';
  if (manual.status === STATUS.BREAK) {
    return { 1: 'QTR TIME', 2: 'HALF TIME', 3: '3QTR TIME' }[manual.quarter] || 'BREAK';
  }
  return LABELS[manual.quarter] || 'LIVE';
}

async function read(cfg) {
  const m = cfg.manual || {};
  const game = makeGame({
    sourceType: 'manual',
    sourceUrl: '',
    homeTeam: m.homeTeam || 'HOME',
    awayTeam: m.awayTeam || 'AWAY',
    homeGoals: m.homeGoals,
    homeBehinds: m.homeBehinds,
    homeScore: m.homeScore,
    awayGoals: m.awayGoals,
    awayBehinds: m.awayBehinds,
    awayScore: m.awayScore,
    quarter: m.quarter,
    clock: m.clock || null,
    status: m.status || STATUS.LIVE
  });
  game.periodLabel = labelFor(game);
  return { game, via: 'manual' };
}

module.exports = {
  id: 'manual',
  label: 'Manual entry',
  placeholder: '',
  canHandle: () => false,
  read
};
