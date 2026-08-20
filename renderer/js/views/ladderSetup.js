import { $, h } from '../util.js';

/**
 * LADDER view — paste the ladder entering the round.
 * Parsing happens in the main process so the UI and the engine can never
 * disagree about what the ladder actually is.
 */

let ctx = { toast: () => {} };
let lastRaw = null;
let previewedRaw = null;

export function init(context) {
  ctx = { ...ctx, ...context };

  $('#ladder-preview-btn').addEventListener('click', () => checkPaste(false));
  $('#ladder-save-btn').addEventListener('click', () => checkPaste(true));

  $('#ladder-paste').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') checkPaste(true);
  });
}

export function onShow(state) {
  if (state) render(state);
}

async function checkPaste(save) {
  const text = $('#ladder-paste').value;
  const feedback = $('#ladder-feedback');

  if (!text.trim()) {
    feedback.replaceChildren(h('div.fb-line.err', { text: 'Paste the ladder first.' }));
    return;
  }

  const res = save ? await window.api.ladder.set(text) : await window.api.ladder.preview(text);

  if (!res.ok) {
    feedback.replaceChildren(h('div.fb-line.err', { text: res.error }));
    renderPreview([]);
    return;
  }

  const lines = [
    h('div.fb-line.ok', {
      text: save
        ? `Loaded ${res.clubs.length} clubs. Games will be matched to these clubs automatically.`
        : `Parsed ${res.clubs.length} clubs — press Load ladder to use it.`
    }),
    ...(res.warnings || []).map((w) => h('div.fb-line.warn', { text: w }))
  ];
  feedback.replaceChildren(...lines);
  renderPreview(res.clubs);

  if (save) {
    ctx.toast(`Ladder loaded — ${res.clubs.length} clubs`, 'ok');
    lastRaw = text;
  }
}

function renderPreview(clubs) {
  const host = $('#ladder-preview');
  $('#preview-count').textContent = clubs.length ? `${clubs.length} clubs` : '';

  if (!clubs.length) {
    host.replaceChildren(h('div.log-empty', { text: 'Nothing parsed yet.' }));
    return;
  }

  host.replaceChildren(
    h('div.prow.head', {},
      h('span.p-pos', { text: '#' }),
      h('span.p-name', { text: 'CLUB' }),
      h('span.p-num', { text: 'P' }),
      h('span.p-num', { text: 'F' }),
      h('span.p-num', { text: 'A' }),
      h('span.p-pts', { text: 'PTS' })
    ),
    ...clubs.map((c) =>
      h('div.prow', {},
        h('span.p-pos', { text: c.startPosition }),
        h('span.p-name', { text: c.name }),
        h('span.p-num', { text: c.played }),
        h('span.p-num', { text: c.pf }),
        h('span.p-num', { text: c.pa }),
        h('span.p-pts', { text: c.pts })
      )
    )
  );
}

export function render(state) {
  if (!state) return;
  const meta = state.ladderMeta || {};
  $('#ladder-meta').textContent = meta.clubCount
    ? `${meta.clubCount} clubs loaded${meta.updatedAt ? ` · ${new Date(meta.updatedAt).toLocaleString()}` : ''}`
    : 'No ladder loaded';

  const box = $('#ladder-paste');
  if (meta.raw && lastRaw === null && document.activeElement !== box && !box.value) {
    box.value = meta.raw;
    lastRaw = meta.raw;
  }

  // Show what is actually loaded, without waiting for the operator to re-check it.
  if (meta.raw && previewedRaw !== meta.raw) {
    previewedRaw = meta.raw;
    window.api.ladder.preview(meta.raw).then((res) => {
      if (res.ok) renderPreview(res.clubs);
    });
  } else if (!meta.raw && !$('#ladder-preview').hasChildNodes()) {
    renderPreview([]);
  }
}
