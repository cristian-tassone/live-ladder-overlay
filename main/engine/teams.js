'use strict';

/**
 * Club name normalisation and matching.
 *
 * Scoring feeds and ladder pastes never agree on naming:
 *   "Bonbeach"                     (Record2020)
 *   "Bonbeach FNC Senior Men"      (ladder paste)
 *   "FRNKSTON YCW" / "DRO"         (scorebug)
 *
 * Auto-matching handles the common cases; anything ambiguous is surfaced in
 * SOURCE so the operator can bind a side to a club by hand. The ladder engine
 * only ever works with the resolved club key.
 */

const NOISE = [
  'football netball club',
  'football club',
  'netball club',
  'senior men',
  'seniors men',
  'senior women',
  'senior mens',
  'reserves',
  'seniors',
  'senior',
  'fnc',
  'fc',
  'afc',
  'jfc',
  'sfnc'
];

/** Canonical comparison key: uppercase letters and digits only, noise words removed. */
function normalise(name) {
  let s = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const word of NOISE) {
    s = s.replace(new RegExp(`(^|\\s)${word}(\\s|$)`, 'g'), ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * On-air name: the club as a commentator would say it, with the club-type
 * boilerplate competition exports carry stripped off.
 * "Frankston Bombers FNC Senior Men" -> "FRANKSTON BOMBERS"
 */
function prettyName(name) {
  const cleaned = String(name || '')
    .replace(/\s+(FNC|FC|AFC|JFC|SFNC)\b/gi, '')
    .replace(/\s+Senior\s+(Men|Women|Mens|Womens)\b/gi, '')
    .replace(/\s+(Reserves|Seniors)\b/gi, '')
    .replace(/\s+Football\s*(&|and)?\s*Netball\s+Club\b/gi, '')
    .replace(/\s+Football\s+Club\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (cleaned || String(name || '').trim()).toUpperCase();
}

/** A short display abbreviation, used when a feed gives us no abbr of its own. */
function abbreviate(name) {
  const n = normalise(name).toUpperCase();
  if (!n) return '';
  const words = n.split(' ');
  if (words.length === 1) return words[0].slice(0, 3);
  return words.map((w) => w[0]).join('').slice(0, 4);
}

function tokens(name) {
  return normalise(name).split(' ').filter(Boolean);
}

/** 0..1 similarity used only as a last resort when nothing matches cleanly. */
function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;

  let hits = 0;
  for (const ta of A) {
    for (const tb of B) {
      if (ta === tb) { hits += 1; break; }
      // Feeds like to drop vowels: "FRNKSTON" vs "FRANKSTON"
      if (ta.length >= 4 && tb.length >= 4 && (ta.startsWith(tb.slice(0, 4)) || tb.startsWith(ta.slice(0, 4)))) {
        hits += 0.75;
        break;
      }
    }
  }
  return hits / Math.max(A.length, B.length);
}

/**
 * Resolve a feed's team name against the ladder's club list.
 * @param {string} feedName
 * @param {Array<{key:string, name:string}>} clubs
 * @returns {{key:string, confidence:'exact'|'contains'|'fuzzy'}|null}
 */
function matchClub(feedName, clubs) {
  const target = normalise(feedName);
  if (!target || !clubs?.length) return null;

  for (const c of clubs) {
    if (normalise(c.name) === target) return { key: c.key, confidence: 'exact' };
  }

  const contains = clubs.filter((c) => {
    const n = normalise(c.name);
    return n && (n.includes(target) || target.includes(n));
  });
  if (contains.length === 1) return { key: contains[0].key, confidence: 'contains' };

  let best = null;
  for (const c of clubs) {
    const score = similarity(feedName, c.name);
    if (!best || score > best.score) best = { key: c.key, score };
  }
  if (best && best.score >= 0.6) return { key: best.key, confidence: 'fuzzy' };
  return null;
}

module.exports = { normalise, prettyName, abbreviate, similarity, matchClub };
