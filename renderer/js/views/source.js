import { $, h, age } from '../util.js';

/**
 * SOURCE view — the control room.
 *
 * One card per game slot. Card DOM is built once and updated in place so the
 * operator can type a URL without a background poll stealing focus or wiping
 * the field mid-edit.
 */

let ctx = { toast: () => {} };
let sourceTypes = [];
/** slot id -> refs */
const cards = new Map();
let clubSignature = '';

const HEALTH_TEXT = {
  idle: 'NOT CONNECTED',
  connecting: 'CONNECTING',
  connected: 'CONNECTED',
  stale: 'STALE',
  error: 'ERROR',
  manual: 'MANUAL'
};

const STATUS_OPTIONS = [
  ['PRE', 'Pre game'],
  ['LIVE', 'Live'],
  ['BREAK', 'Break'],
  ['FINAL', 'Final']
];

export async function init(context) {
  ctx = { ...ctx, ...context };
  sourceTypes = await window.api.sources();

  const connectAllBtn = $('#connect-all');
  $('#test-mode').addEventListener('click', async () => {
    const button = $('#test-mode');
    button.disabled = true;
    button.textContent = 'STARTING…';
    await window.api.testMode();
    button.disabled = false;
    button.textContent = 'TEST MODE';
    ctx.toast('Test mode started — simulated scores are updating', 'ok');
  });
  connectAllBtn.addEventListener('click', async () => {
    connectAllBtn.disabled = true;
    connectAllBtn.textContent = 'CONNECTING…';
    const results = await window.api.slot.connectAll();
    connectAllBtn.disabled = false;
    connectAllBtn.textContent = 'CONNECT ALL';
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (!results.length) ctx.toast('Nothing to connect — paste a scoring link first', 'error');
    else if (!failed.length) ctx.toast(`${ok} game${ok === 1 ? '' : 's'} connected`, 'ok');
    else ctx.toast(`${ok} connected, ${failed.length} failed: ${failed.map((f) => f.label).join(', ')}`, 'error');
  });

  $('#poll-interval').addEventListener('change', async (e) => {
    await window.api.settings.poll(Number(e.target.value));
    ctx.toast(`Polling every ${Number(e.target.value) / 1000}s`, 'ok');
  });

  let roundTimer;
  $('#round-label').addEventListener('input', (e) => {
    clearTimeout(roundTimer);
    const value = e.target.value;
    roundTimer = setTimeout(() => window.api.settings.round(value), 400);
  });
}

export function onShow(state) {
  if (state) render(state);
}

/* ------------------------------ card build ------------------------------ */

function stepper(cap, onChange) {
  const input = h('input', { type: 'text', inputmode: 'numeric', value: '0' });
  const bump = (d) => {
    const next = Math.max(0, (parseInt(input.value, 10) || 0) + d);
    input.value = String(next);
    onChange(next);
  };
  input.addEventListener('change', () => {
    const next = Math.max(0, parseInt(input.value, 10) || 0);
    input.value = String(next);
    onChange(next);
  });
  const el = h('div.stepper', {},
    h('span.cap', { text: cap }),
    h('button', { type: 'button', text: '−', onclick: () => bump(-1) }),
    input,
    h('button', { type: 'button', text: '+', onclick: () => bump(1) })
  );
  return { el, input };
}

function buildCard(slot) {
  const refs = {};

  refs.pill = h('span.status-pill', { 'data-health': 'idle', text: 'NOT CONNECTED' });

  refs.type = h('select.type-select', {},
    ...sourceTypes.map((t) => h('option', { value: t.id, text: t.label }))
  );
  refs.type.addEventListener('change', () => {
    window.api.slot.update(slot.id, { type: refs.type.value });
    refs.url.placeholder = sourceTypes.find((t) => t.id === refs.type.value)?.placeholder || '';
  });

  refs.url = h('input.url-input', { type: 'text', placeholder: 'Paste the live scoring link', spellcheck: 'false' });
  let urlTimer;
  refs.url.addEventListener('input', () => {
    clearTimeout(urlTimer);
    const value = refs.url.value.trim();
    urlTimer = setTimeout(async () => {
      const detected = await window.api.detectType(value);
      const patch = { url: value };
      if (detected && detected !== refs.type.value) {
        patch.type = detected;
        refs.type.value = detected;
      }
      window.api.slot.update(slot.id, patch);
    }, 300);
  });
  refs.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') refs.connect.click(); });

  refs.preview = h('div.scard-preview');

  refs.mapHome = h('select');
  refs.mapAway = h('select');
  refs.mapHome.addEventListener('change', () => {
    window.api.slot.update(slot.id, { mapping: { home: refs.mapHome.value || null } });
  });
  refs.mapAway.addEventListener('change', () => {
    window.api.slot.update(slot.id, { mapping: { away: refs.mapAway.value || null } });
  });
  refs.mapHomeField = h('div.map-field', {}, h('label', { text: 'HOME CLUB ON LADDER' }), refs.mapHome);
  refs.mapAwayField = h('div.map-field', {}, h('label', { text: 'AWAY CLUB ON LADDER' }), refs.mapAway);

  refs.msg = h('div.scard-msg');

  refs.connect = h('button.btn.btn-primary', { text: 'CONNECT' });
  refs.connect.addEventListener('click', async () => {
    refs.connect.disabled = true;
    refs.connect.textContent = 'CHECKING…';
    const res = await window.api.slot.connect(slot.id);
    refs.connect.disabled = false;
    if (res.ok) {
      ctx.toast(`${slot.label} connected — ${res.game.homeTeam} v ${res.game.awayTeam}`, 'ok');
    } else {
      ctx.toast(`${slot.label}: ${res.error}`, 'error');
    }
  });

  refs.disconnect = h('button.btn.btn-ghost.btn-sm', { text: 'DISCONNECT' });
  refs.disconnect.addEventListener('click', () => window.api.slot.disconnect(slot.id));

  refs.clear = h('button.btn.btn-ghost.btn-sm', { text: 'CLEAR' });
  refs.clear.addEventListener('click', () => {
    window.api.slot.clear(slot.id);
    refs.url.value = '';
  });

  refs.manualToggle = h('input', { type: 'checkbox' });
  refs.manualToggle.addEventListener('change', () => {
    window.api.slot.manual(slot.id, refs.manualToggle.checked);
  });

  // ---- manual panel ----
  const patchManual = (patch) => window.api.slot.update(slot.id, { manual: patch });

  refs.mHomeTeam = h('input.m-team', { type: 'text', placeholder: 'Home team' });
  refs.mAwayTeam = h('input.m-team', { type: 'text', placeholder: 'Away team' });
  refs.mHomeTeam.addEventListener('change', () => patchManual({ homeTeam: refs.mHomeTeam.value }));
  refs.mAwayTeam.addEventListener('change', () => patchManual({ awayTeam: refs.mAwayTeam.value }));

  refs.mHomeG = stepper('G', (v) => patchManual({ homeGoals: v }));
  refs.mHomeB = stepper('B', (v) => patchManual({ homeBehinds: v }));
  refs.mAwayG = stepper('G', (v) => patchManual({ awayGoals: v }));
  refs.mAwayB = stepper('B', (v) => patchManual({ awayBehinds: v }));

  refs.mQuarter = h('select', {},
    ...[1, 2, 3, 4].map((q) => h('option', { value: String(q), text: `Q${q}` }))
  );
  refs.mQuarter.addEventListener('change', () => patchManual({ quarter: Number(refs.mQuarter.value) }));

  refs.mClock = h('input', { type: 'text', placeholder: '12:18' });
  refs.mClock.addEventListener('change', () => patchManual({ clock: refs.mClock.value }));

  refs.mStatus = h('select', {}, ...STATUS_OPTIONS.map(([v, t]) => h('option', { value: v, text: t })));
  refs.mStatus.addEventListener('change', () => patchManual({ status: refs.mStatus.value }));

  refs.manualPanel = h('div.manual-panel', {},
    h('div.manual-grid', {},
      refs.mHomeTeam, refs.mHomeG.el, refs.mHomeB.el,
      refs.mAwayTeam, refs.mAwayG.el, refs.mAwayB.el
    ),
    h('div.manual-meta', {},
      h('div', {}, h('label', { text: 'QUARTER' }), refs.mQuarter),
      h('div', {}, h('label', { text: 'CLOCK' }), refs.mClock),
      h('div', {}, h('label', { text: 'STATUS' }), refs.mStatus)
    )
  );

  refs.el = h('div.scard', { 'data-slot': slot.id, 'data-health': 'idle' },
    h('div.scard-head', {},
      h('span.scard-title', { text: slot.label }),
      refs.pill
    ),
    h('div.scard-body', {},
      h('div.scard-row', {}, refs.type, refs.url),
      refs.preview,
      h('div.scard-map', {}, refs.mapHomeField, refs.mapAwayField),
      refs.msg,
      refs.manualPanel,
      h('div.scard-actions', {},
        refs.connect,
        refs.disconnect,
        refs.clear,
        h('span.spacer'),
        h('label.toggle', {},
          refs.manualToggle,
          h('span.track'),
          h('span.toggle-label', { text: 'MANUAL' })
        )
      )
    )
  );

  return refs;
}

/* -------------------------------- update -------------------------------- */

function fillClubs(select, clubs, value) {
  select.replaceChildren(
    h('option', { value: '', text: '— not mapped —' }),
    ...clubs.map((c) => h('option', { value: c.key, text: c.name }))
  );
  select.value = value || '';
}

function renderPreview(refs, slot) {
  const g = slot.game;
  if (!g) {
    refs.preview.replaceChildren(
      h('div.preview-empty', {
        text: slot.manualMode ? 'Manual values will appear here.' : 'Connect a source to preview its live data.'
      })
    );
    return;
  }

  const homeLead = g.homeScore >= g.awayScore;
  refs.preview.replaceChildren(
    h(`div.pv-side${homeLead ? '.leading' : ''}`, {},
      h('span.pv-team', { text: g.homeTeam }),
      h('span.pv-gb', { text: `${g.homeGoals}.${g.homeBehinds}` }),
      h('span.pv-total', { text: g.homeScore })
    ),
    h(`div.pv-side${!homeLead ? '.leading' : ''}`, {},
      h('span.pv-team', { text: g.awayTeam }),
      h('span.pv-gb', { text: `${g.awayGoals}.${g.awayBehinds}` }),
      h('span.pv-total', { text: g.awayScore })
    ),
    h('div.pv-foot', {},
      h('span', { text: `${g.periodLabel || g.status}${g.clock ? ` — ${g.clock}` : ''}` }),
      h('span.age', { 'data-age': slot.lastGoodAt || '', text: age(slot.lastGoodAt) }),
      h('span.via', { text: slot.via === 'browser' ? 'VIA PAGE' : slot.via === 'manual' ? 'MANUAL' : 'VIA FEED' })
    )
  );
}

function updateCard(refs, slot, clubs, clubsChanged) {
  refs.el.dataset.health = slot.health;
  refs.pill.dataset.health = slot.health;
  refs.pill.textContent = HEALTH_TEXT[slot.health] || slot.health.toUpperCase();
  refs.el.classList.toggle('is-manual', slot.manualMode);

  if (document.activeElement !== refs.url && refs.url.value !== slot.url) refs.url.value = slot.url || '';
  if (document.activeElement !== refs.type) refs.type.value = slot.type;
  refs.url.placeholder = sourceTypes.find((t) => t.id === slot.type)?.placeholder || 'Paste the live scoring link';
  refs.url.disabled = slot.manualMode;
  refs.type.disabled = slot.manualMode;

  refs.manualToggle.checked = slot.manualMode;
  refs.connect.textContent = slot.health === 'connected' || slot.health === 'stale' ? 'RECONNECT' : 'CONNECT';
  refs.connect.style.display = slot.manualMode ? 'none' : '';
  refs.disconnect.style.display = slot.enabled ? '' : 'none';

  renderPreview(refs, slot);

  if (clubsChanged || refs.mapHome.options.length <= 1) {
    fillClubs(refs.mapHome, clubs, slot.mapping.home);
    fillClubs(refs.mapAway, clubs, slot.mapping.away);
  } else {
    if (document.activeElement !== refs.mapHome) refs.mapHome.value = slot.mapping.home || '';
    if (document.activeElement !== refs.mapAway) refs.mapAway.value = slot.mapping.away || '';
  }
  refs.mapHomeField.classList.toggle('unmapped', slot.enabled && !slot.mapping.home);
  refs.mapAwayField.classList.toggle('unmapped', slot.enabled && !slot.mapping.away);
  const showMap = clubs.length > 0 && (slot.enabled || slot.game);
  refs.mapHomeField.parentElement.style.display = showMap ? '' : 'none';

  refs.msg.className = 'scard-msg';
  if (slot.lastError && (slot.health === 'error' || slot.health === 'stale')) {
    refs.msg.classList.add('is-error');
    refs.msg.textContent = slot.lastError;
  } else if (slot.warning) {
    refs.msg.classList.add('is-warn');
    refs.msg.textContent = slot.warning;
  } else {
    refs.msg.textContent = '';
  }

  // manual fields (never fight the operator's cursor)
  const m = slot.manual || {};
  const setIf = (el, value) => {
    if (document.activeElement !== el && el.value !== String(value ?? '')) el.value = value ?? '';
  };
  setIf(refs.mHomeTeam, m.homeTeam);
  setIf(refs.mAwayTeam, m.awayTeam);
  setIf(refs.mHomeG.input, m.homeGoals ?? 0);
  setIf(refs.mHomeB.input, m.homeBehinds ?? 0);
  setIf(refs.mAwayG.input, m.awayGoals ?? 0);
  setIf(refs.mAwayB.input, m.awayBehinds ?? 0);
  setIf(refs.mQuarter, m.quarter ?? 1);
  setIf(refs.mClock, m.clock ?? '');
  setIf(refs.mStatus, m.status ?? 'LIVE');
}

export function render(state) {
  if (!state) return;
  const host = $('#source-grid');
  const clubs = state.clubs || [];
  const signature = clubs.map((c) => c.key).join('|');
  const clubsChanged = signature !== clubSignature;
  clubSignature = signature;

  for (const slot of state.slots) {
    let refs = cards.get(slot.id);
    if (!refs) {
      refs = buildCard(slot);
      cards.set(slot.id, refs);
      host.append(refs.el);
    }
    updateCard(refs, slot, clubs, clubsChanged);
  }

  const poll = $('#poll-interval');
  if (document.activeElement !== poll) poll.value = String(state.settings.pollInterval || 5000);
  const round = $('#round-label');
  if (document.activeElement !== round) round.value = state.settings.roundLabel || '';
}

export function tickAges(state) {
  if (!state) return;
  for (const slot of state.slots) {
    const refs = cards.get(slot.id);
    if (!refs) continue;
    const el = refs.preview.querySelector('.age');
    if (el && slot.lastGoodAt) el.textContent = age(slot.lastGoodAt);
  }
}
