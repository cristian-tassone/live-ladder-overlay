'use strict';

/**
 * Ladder paste parser.
 *
 * Handles the two-block layout copied straight off the competition site:
 *
 *   #  Team
 *   1  Chelsea FNC Senior Men
 *   ...
 *
 *   P  PTS  %      W   L  D  BYE  F     A     FORF  DISQ  ADJ
 *   18 60   176.62 15  3  0  0    2017  1142  0     0     0
 *   ...
 *
 * The two blocks are zipped by row order. A single-block layout (name and
 * numbers on the same line) is also accepted. Column meaning comes from the
 * header row, so extra or reordered columns are handled without code changes.
 */

const { normalise, prettyName } = require('./teams');

const COLUMN_ALIASES = {
  p: 'played', pld: 'played', played: 'played', games: 'played', gp: 'played',
  pts: 'pts', points: 'pts',
  '%': 'pct', pct: 'pct', percentage: 'pct', perc: 'pct',
  w: 'w', won: 'w', wins: 'w',
  l: 'l', lost: 'l', losses: 'l',
  d: 'd', drawn: 'd', draw: 'd', draws: 'd',
  bye: 'byes', byes: 'byes', b: 'byes',
  f: 'pf', pf: 'pf', for: 'pf', gf: 'pf', 'pts f': 'pf',
  a: 'pa', pa: 'pa', against: 'pa', ga: 'pa', 'pts a': 'pa',
  forf: 'forf', forfeit: 'forf', forfeits: 'forf',
  disq: 'disq',
  adj: 'adj', adjust: 'adj', adjustment: 'adj'
};

function splitCells(line) {
  // Tabs first (that is what a real copy/paste gives); otherwise 2+ spaces.
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  return line.trim().split(/\s{2,}|\s+/).map((c) => c.trim());
}

function isNumericCell(c) {
  return /^-?\d+(\.\d+)?$/.test(String(c).replace(/,/g, ''));
}

function toNumber(c) {
  const n = Number(String(c).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function mapHeader(cells) {
  const cols = cells.map((c) => {
    const key = String(c).trim().toLowerCase().replace(/\.$/, '');
    return COLUMN_ALIASES[key] || null;
  });
  const known = cols.filter(Boolean).length;
  return known >= 3 ? cols : null;
}

function clubKey(name, taken) {
  let base = normalise(name).replace(/\s+/g, '-') || 'club';
  let key = base;
  let i = 2;
  while (taken.has(key)) key = `${base}-${i++}`;
  taken.add(key);
  return key;
}

/**
 * @param {string} text raw pasted ladder
 * @returns {{clubs:Array, warnings:string[]}}
 */
function parseLadder(text) {
  const warnings = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, ' ').trimEnd())
    .filter((l) => l.trim().length > 0);

  if (!lines.length) throw new Error('Nothing to parse — paste the ladder first');

  /** @type {Array<{rank:number|null, name:string}>} */
  const names = [];
  /** @type {Array<Record<string, number>>} */
  const stats = [];
  let statCols = null;
  let inStats = false;

  for (const line of lines) {
    const cells = splitCells(line).filter((c, i, arr) => !(c === '' && i === arr.length - 1));
    if (!cells.length) continue;

    const header = mapHeader(cells);
    if (header) {
      statCols = header;
      inStats = true;
      continue;
    }

    // "# Team" header
    if (/^#?$/.test(cells[0]) && /team|club/i.test(cells[1] || '')) {
      inStats = false;
      continue;
    }

    const allNumeric = cells.every(isNumericCell);

    if (inStats && statCols && allNumeric) {
      const row = {};
      cells.forEach((c, i) => {
        const key = statCols[i];
        if (key) row[key] = toNumber(c);
      });
      stats.push(row);
      continue;
    }

    // Name row: "1  Chelsea FNC Senior Men" or just "Chelsea FNC Senior Men",
    // optionally with its numbers trailing on the same line.
    let idx = 0;
    let rank = null;
    if (isNumericCell(cells[0]) && cells.length > 1 && !isNumericCell(cells[1])) {
      rank = toNumber(cells[0]);
      idx = 1;
    }
    // The name may span several cells when the paste is space-separated.
    let end = idx;
    while (end < cells.length && !isNumericCell(cells[end])) end += 1;
    const name = cells.slice(idx, end).join(' ').trim();
    if (!name) continue;

    const trailing = cells.slice(end).filter((c) => c !== '');
    if (trailing.length >= 3 && trailing.every(isNumericCell) && statCols) {
      const row = {};
      // Single-block layout: stat columns start after the name column.
      const offset = statCols.findIndex((c) => c !== null);
      trailing.forEach((c, i) => {
        const key = statCols[offset + i];
        if (key) row[key] = toNumber(c);
      });
      names.push({ rank, name });
      stats.push(row);
    } else {
      names.push({ rank, name });
    }
  }

  if (!names.length) throw new Error('No club names found in that paste');

  if (stats.length && stats.length !== names.length) {
    warnings.push(
      `Found ${names.length} clubs but ${stats.length} stat rows — matched what I could, please check the numbers.`
    );
  }
  if (!stats.length) {
    warnings.push('No stat rows found — clubs were added with zeroed records.');
  }

  const taken = new Set();
  const clubs = names.map((n, i) => {
    const s = stats[i] || {};
    const played = s.played ?? (s.w ?? 0) + (s.l ?? 0) + (s.d ?? 0);
    const pf = s.pf ?? 0;
    const pa = s.pa ?? 0;
    const pts = s.pts ?? (s.w ?? 0) * 4 + (s.d ?? 0) * 2 + (s.byes ?? 0) * 4 + (s.adj ?? 0);

    return {
      key: clubKey(n.name, taken),
      name: n.name,
      display: prettyName(n.name),
      played,
      w: s.w ?? 0,
      l: s.l ?? 0,
      d: s.d ?? 0,
      byes: s.byes ?? 0,
      pf,
      pa,
      pts,
      adj: s.adj ?? 0,
      // Percentage is recomputed from F/A; the pasted value is kept only to
      // warn if the paste itself is inconsistent.
      pastedPct: s.pct ?? null,
      startPosition: n.rank || i + 1
    };
  });

  // Sanity check the paste: does F/A reproduce the published percentage?
  for (const c of clubs) {
    if (c.pastedPct != null && c.pa > 0) {
      const calc = (c.pf / c.pa) * 100;
      if (Math.abs(calc - c.pastedPct) > 0.6) {
        warnings.push(
          `${c.name}: F/A gives ${calc.toFixed(2)}% but the paste says ${c.pastedPct.toFixed(2)}%.`
        );
      }
    } else if (c.pa === 0 && c.played > 0) {
      warnings.push(`${c.name}: no points-for/against in the paste — live percentage will not move for this club.`);
    }
  }

  clubs.sort((a, b) => a.startPosition - b.startPosition);
  clubs.forEach((c, i) => { c.startPosition = i + 1; });

  return { clubs, warnings };
}

module.exports = { parseLadder };
