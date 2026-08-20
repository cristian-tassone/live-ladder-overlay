import { $, h, age, pctText, clockTime, clamp } from '../util.js';

/**
 * LIVE view.
 *
 * The ladder is a set of persistent, absolutely-positioned rows. Reordering is
 * done by changing each row's --i; the browser handles the motion. Rows that
 * actually changed position are lifted toward the viewer in 3D so a move is
 * visible from across the room, then settle back.
 *
 * Nothing here decides what a "move" is — position events arrive from the
 * detection layer in the main process.
 */

const MOVE_MS = 950;
const GOAL_MS = 1000;
const FINALS_CUT = 5;

let ctx = { toast: () => {} };

/** club key -> { el, num, index } */
const rows = new Map();
/** slot id -> element */
const cards = new Map();
const loggedIds = new Set();

let lastLadderSignature = '';
let rowHeight = 54;

function tickText(el, value, accent = false) {
  const next = String(value ?? '');
  if (el.textContent === next) return;
  const hadValue = el.textContent !== '';
  clearTimeout(el._tickTimer);
  if (!hadValue) {
    el.textContent = next;
    return;
  }
  const old = el.textContent;
  el.classList.remove('number-slide', 'is-sliding');
  el.classList.toggle('is-pct-tick', accent);
  el.innerHTML = `<span class="number-old">${old}</span><span class="number-next">${next}</span>`;
  el.classList.add('number-slide');
  requestAnimationFrame(() => el.classList.add('is-sliding'));
  clearTimeout(el._tickTimer);
  el._tickTimer = setTimeout(() => {
    el.textContent = next;
    el.classList.remove('number-slide', 'is-sliding');
  }, 920);
}

export function init(context) {
  ctx = { ...ctx, ...context };
  $('#clear-log').addEventListener('click', async () => {
    await window.api.clearLog();
    loggedIds.clear();
    $('#log-list').replaceChildren();
    renderLog({ log: [] });
  });
  window.addEventListener('resize', () => sizeRows());

  const side = document.querySelector('.side-panel');
  const resizer = $('#updates-resizer');
  let resizing = false;
  const setUpdatesHeight = (clientY) => {
    if (!side) return;
    const bounds = side.getBoundingClientRect();
    const height = Math.max(120, Math.min(bounds.height - 210, bounds.bottom - clientY));
    side.style.setProperty('--updates-height', `${Math.round(height)}px`);
  };
  resizer.addEventListener('pointerdown', (e) => {
    resizing = true;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing-panels');
    setUpdatesHeight(e.clientY);
  });
  resizer.addEventListener('pointermove', (e) => { if (resizing) setUpdatesHeight(e.clientY); });
  const stopResize = () => {
    if (!resizing) return;
    resizing = false;
    document.body.classList.remove('is-resizing-panels');
  };
  resizer.addEventListener('pointerup', stopResize);
  resizer.addEventListener('pointercancel', stopResize);
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const current = parseFloat(getComputedStyle(side).getPropertyValue('--updates-height')) || 260;
    side.style.setProperty('--updates-height', `${Math.max(120, current + (e.key === 'ArrowUp' ? 30 : -30))}px`);
  });
}

export function onShow() {
  sizeRows();
}

/* ------------------------------- sizing ------------------------------- */

function sizeRows() {
  const host = $('#ladder-rows');
  if (!host) return;
  const count = rows.size || 12;
  const available = host.clientHeight - 16;
  if (available <= 0) return;
  rowHeight = clamp(Math.floor(available / count), 38, 84);
  host.style.setProperty('--row-h', `${rowHeight}px`);
  host.style.height = '';
}

/* ------------------------------- ladder ------------------------------- */

function buildRow(row) {
  const num = h('span.lrow-num', { text: String(row.position) });
  const delta = h('span.lrow-delta');
  const dot = h('span.lrow-livedot.is-hidden');
  const name = ho('span.lrow-name', row.name);
  const cxt = h('span.lrow-ctx');
  const impact = h('span.lrow-impact');

  const el = h('div.lrow', { 'data-key': row.key },
    h('div.lrow-pos', {}, num, delta),
    h('div.lrow-team', {}, dot, name, cxt, impact),
    h('span.lrow-pts'),
    h('span.lrow-stat.lrow-pct'),
    h('span.lrow-stat.st-p'),
    h('span.lrow-stat.st-w'),
    h('span.lrow-stat.st-l'),
    h('span.lrow-stat.st-d')
  );

  return { el, num, delta, dot, name, cxt, impact, index: null };
}

function ho(spec, text) {
  return h(spec, { text });
}

/** Strip the boilerplate clubs carry in competition exports. */
function displayName(name) {
  return String(name)
    .replace(/\s+(FNC|FC|AFC|JFC)\b/gi, '')
    .replace(/\s+Senior\s+(Men|Women)\b/gi, '')
    .replace(/\s+Football\s+Netball\s+Club\b/gi, '')
    .trim()
    .toUpperCase();
}

function shortName(name) {
  const clean = displayName(name);
  return clean.length > 10 ? clean.split(/\s+/).map((w) => w.slice(0, 3)).join(' ').slice(0, 9) : clean;
}

function renderLadder(state, events) {
  const panel = $('.ladder-panel');
  const host = $('#ladder-rows');
  const ladder = state.ladder || [];

  panel.classList.toggle('is-empty', ladder.length === 0);
  if (!ladder.length) {
    rows.forEach((r) => r.el.remove());
    rows.clear();
    return;
  }

  // Which clubs genuinely changed position this tick?
  const movedKeys = new Map();
  for (const e of events || []) {
    if (e.type === 'position') movedKeys.set(e.key, { direction: e.direction, jump: e.jump || 1 });
  }

  const seen = new Set();
  const isFirstPaint = rows.size === 0;

  for (const row of ladder) {
    seen.add(row.key);
    let entry = rows.get(row.key);
    if (!entry) {
      entry = buildRow(row);
      rows.set(row.key, entry);
      entry.el.classList.add('no-anim');
      host.append(entry.el);
    }

    const { el, num, delta, dot, name, cxt } = entry;
    const newIndex = row.position - 1;
    const positionChanged = entry.index !== null && entry.index !== newIndex;

    el.style.setProperty('--i', newIndex);
    entry.index = newIndex;

    if (num.textContent !== String(row.position)) {
      tickText(num, row.position);
      if (!isFirstPaint) {
        num.classList.remove('flip');
        void num.offsetWidth;
        num.classList.add('flip');
      }
    }

    // movement context entering the round
    if (row.delta > 0) {
      delta.textContent = `▲${row.delta}`;
      delta.className = 'lrow-delta up';
    } else if (row.delta < 0) {
      delta.textContent = `▼${Math.abs(row.delta)}`;
      delta.className = 'lrow-delta down';
    } else {
      delta.textContent = '';
      delta.className = 'lrow-delta';
    }

    name.textContent = row.display || displayName(row.name);

    dot.classList.toggle('is-hidden', !row.live);
    el.classList.toggle('is-live-game', !!row.live);
    el.classList.toggle('is-top', row.position === 1);
    el.classList.toggle('is-finals', row.position <= FINALS_CUT);
    el.classList.toggle('is-cut', row.position === FINALS_CUT);

    if (row.live && row.opponent) {
      const sign = row.margin > 0 ? '+' : '';
      const cls = row.liveResult === 'W' ? 'res-w' : row.liveResult === 'L' ? 'res-l' : 'res-d';
      cxt.innerHTML = `v ${shortName(row.opponent)} <span class="${cls}">${sign}${row.margin}</span>`;
    } else {
      cxt.textContent = '';
    }

    tickText(el.querySelector('.st-p'), row.played);
    tickText(el.querySelector('.st-w'), row.w);
    tickText(el.querySelector('.st-l'), row.l);
    tickText(el.querySelector('.st-d'), row.d);
    tickText(el.querySelector('.lrow-pct'), pctText(row.pct), true);
    tickText(el.querySelector('.lrow-pts'), row.pts);

    // The big moment: lift the row out of the plane while it travels.
    const move = movedKeys.get(row.key);
    if (move && positionChanged) {
      const { direction: dir, jump } = move;
      el.classList.remove('moving', 'up', 'down', 'settled');
      void el.offsetWidth;
      el.classList.add('moving', dir);
      entry.impact.textContent = `${dir === 'up' ? 'MOVED UP' : 'MOVED DOWN'} ${jump}`;
      entry.impact.className = `lrow-impact ${dir}`;
      clearTimeout(entry.impactTimer);
      entry.impactTimer = setTimeout(() => {
        entry.impact.className = 'lrow-impact';
        entry.impact.textContent = '';
      }, 2400);
      clearTimeout(entry.moveTimer);
      entry.moveTimer = setTimeout(() => {
        el.classList.remove('moving', 'up', 'down');
        el.classList.add('settled');
        setTimeout(() => el.classList.remove('settled'), 1500);
      }, MOVE_MS);
    }
  }

  for (const [key, entry] of rows) {
    if (!seen.has(key)) {
      entry.el.remove();
      rows.delete(key);
    }
  }

  if (isFirstPaint) {
    sizeRows();
    requestAnimationFrame(() => {
      rows.forEach((r) => r.el.classList.remove('no-anim'));
    });
  }

  const signature = ladder.map((r) => r.key).join('|');
  if (signature !== lastLadderSignature) {
    lastLadderSignature = signature;
    sizeRows();
  }

  const inPlay = new Set(ladder.filter((r) => r.live && r.gameId).map((r) => r.gameId)).size;
  $('#ladder-head-meta').innerHTML = inPlay
    ? `<span>${inPlay} GAME${inPlay === 1 ? '' : 'S'} COUNTED</span><span>${ladder.length} CLUBS</span>`
    : `<span>${ladder.length} CLUBS</span>`;
}

/* ------------------------------ game cards ------------------------------ */

function buildCard(slot) {
  const el = h('div.gcard', { 'data-slot': slot.id },
    h('div.goal-sweep'),
    h('div.goal-chip', { text: 'GOAL' }),
    h('div.gcard-top', {},
      h('span.gcard-label'),
      h('div.gcard-state', {}, h('span.health'), h('span.period'), h('span.clock'))
    ),
    h('div.gcard-side.home', {}, h('span.gcard-team'), h('span.gcard-gb'), h('span.gcard-total')),
    h('div.gcard-side.away', {}, h('span.gcard-team'), h('span.gcard-gb'), h('span.gcard-total')),
    h('div.gcard-unmapped')
  );
  return el;
}

function renderCards(state, events) {
  const host = $('#game-cards');
  // LIVE is intentionally a four-game broadcast panel. Additional connected
  // slots remain available in SOURCE but do not enter this view.
  const active = state.slots.filter((s) => s.enabled && s.game).slice(0, 4);

  if (!active.length) {
    host.replaceChildren(
      h('div.games-empty', {
        text: state.slots.some((s) => s.enabled)
          ? 'Waiting for the first read from your sources…'
          : 'No games connected. Open SOURCE to connect the round.'
      })
    );
    cards.clear();
    return;
  }

  if (host.querySelector('.games-empty')) host.replaceChildren();

  const seen = new Set();
  for (const slot of active) {
    seen.add(slot.id);
    let el = cards.get(slot.id);
    if (!el) {
      el = buildCard(slot);
      cards.set(slot.id, el);
      host.append(el);
    }

    const g = slot.game;
    el.querySelector('.gcard-label').textContent = slot.label;
    el.querySelector('.health').className = `health ${slot.health}`;
    el.querySelector('.period').textContent = g.periodLabel || g.status;
    tickText(el.querySelector('.clock'), g.clock && g.status === 'LIVE' ? g.clock : '');

    const home = el.querySelector('.gcard-side.home');
    const away = el.querySelector('.gcard-side.away');
    home.querySelector('.gcard-team').textContent = displayName(g.homeTeam);
    away.querySelector('.gcard-team').textContent = displayName(g.awayTeam);
    tickText(home.querySelector('.gcard-gb'), `${g.homeGoals}.${g.homeBehinds}`);
    tickText(away.querySelector('.gcard-gb'), `${g.awayGoals}.${g.awayBehinds}`);
    tickText(home.querySelector('.gcard-total'), g.homeScore);
    tickText(away.querySelector('.gcard-total'), g.awayScore);
    home.classList.toggle('leading', g.homeScore >= g.awayScore);
    away.classList.toggle('leading', g.awayScore >= g.homeScore);

    el.classList.toggle('is-live', g.status === 'LIVE');
    el.classList.toggle('is-final', g.status === 'FINAL');
    el.classList.toggle('is-pre', g.status === 'PRE');

    const unmapped = !slot.mapping.home || !slot.mapping.away;
    const warn = el.querySelector('.gcard-unmapped');
    warn.textContent = unmapped ? 'NOT ON THE LADDER — MAP THIS GAME IN SOURCE' : '';
    warn.style.display = unmapped ? '' : 'none';
  }

  for (const [id, el] of cards) {
    if (!seen.has(id)) {
      el.remove();
      cards.delete(id);
    }
  }

  // Goal treatment stays local to the card that scored.
  for (const e of events || []) {
    if (e.type !== 'goal') continue;
    const el = cards.get(e.slotId);
    if (!el) continue;
    const cls = e.side === 'home' ? 'goal-home' : 'goal-away';
    el.querySelector('.goal-chip').textContent = `${displayName(e.team)} GOAL`;
    el.classList.remove('goal-home', 'goal-away');
    void el.offsetWidth;
    el.classList.add(cls);
    clearTimeout(el._goalTimer);
    el._goalTimer = setTimeout(() => el.classList.remove(cls), GOAL_MS);
  }
}

/* --------------------------------- log --------------------------------- */

function renderLog(state) {
  const host = $('#log-list');
  const log = state.log || [];

  if (!log.length) {
    if (!host.querySelector('.log-empty')) {
      host.replaceChildren(
        h('div.log-empty', {
          html: 'No updates yet.<br>Ladder changes and match notes appear here live.'
        })
      );
    }
    loggedIds.clear();
    return;
  }

  const empty = host.querySelector('.log-empty');
  if (empty) empty.remove();

  // State log is newest-first. Insert older unseen rows first so every new
  // event ends up above it, then mark the newest inserted row as the hero.
  let newestItem = null;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const e = log[i];
    if (loggedIds.has(e.id)) continue;
    loggedIds.add(e.id);
    const cls = e.type === 'note'
      ? `note ${e.kind || ''}`
      : e.type === 'final' ? 'final' : e.direction === 'up' ? 'up' : 'down';
    const item = h(`div.log-item.${cls}`, {},
        h('span.log-time', { text: clockTime(e.at) }),
        h('span.log-text', { text: e.text })
      );
    newestItem = item;
    host.prepend(item);
  }
  if (newestItem) {
    host.querySelector('.is-newest')?.classList.remove('is-newest');
    newestItem.classList.add('is-newest');
  }

  while (host.children.length > 60) host.lastElementChild.remove();
}

/* -------------------------------- render -------------------------------- */

let _widthLogged = false;
export function render(state, events = []) {
  if (!state) return;
  renderLadder(state, events);
  renderCards(state, events);
  renderLog(state);
  if (!_widthLogged) {
    _widthLogged = true;
    requestAnimationFrame(() => {
      const ll = document.querySelector('.live-layout');
      const lp = document.querySelector('.ladder-panel');
      const sp = document.querySelector('.side-panel');
      const gp = document.querySelector('.games-panel');
      const gc = document.querySelector('.game-cards');
      const card = document.querySelector('.gcard');
      const side = card?.querySelector('.gcard-side');
      const team = card?.querySelector('.gcard-team');
      const total = card?.querySelector('.gcard-total');
      const log = (el, name) => el ? `${name}=${Math.round(el.getBoundingClientRect().width)}` : `${name}=null`;
      console.log(`WIDTHS: viewport=${window.innerWidth} ${log(ll,'layout')} ${log(lp,'ladder')} ${log(sp,'side')} ${log(gp,'games')} ${log(gc,'cards')} ${log(card,'card')} ${log(side,'gside')} ${log(team,'team')} ${log(total,'total')}`);
      if (lp) console.log(`LADDER-STYLE: flex=${getComputedStyle(lp).flex} min-w=${getComputedStyle(lp).minWidth} overflow=${getComputedStyle(lp).overflow}`);
      if (sp) console.log(`SIDE-STYLE: flex=${getComputedStyle(sp).flex} min-w=${getComputedStyle(sp).minWidth} overflow=${getComputedStyle(sp).overflow}`);
    });
  }

  const enabled = state.slots.filter((s) => s.enabled).length;
  const healthy = state.slots.filter((s) => s.enabled && (s.health === 'connected' || s.health === 'manual')).length;
  $('#games-head-meta').innerHTML = enabled
    ? `<span>${healthy}/${enabled} FEEDS OK</span>`
    : '<span>NO FEEDS</span>';
}

export function tickAges(state) {
  if (!state) return;
  for (const slot of state.slots) {
    const el = cards.get(slot.id);
    if (!el || !slot.lastGoodAt) continue;
    const stale = slot.health === 'stale' || slot.health === 'error';
    const clock = el.querySelector('.clock');
    if (stale) clock.textContent = age(slot.lastGoodAt);
  }
}
