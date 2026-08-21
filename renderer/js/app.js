import { $, $$, h, age } from './util.js';
import * as source from './views/source.js';
import * as ladderSetup from './views/ladderSetup.js';
import * as live from './views/live.js';

/** @type {object|null} last snapshot pushed from the main process */
let state = null;
let currentView = 'live';

function applyTheme(theme) {
  const mode = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = mode;
  const button = $('#theme-toggle');
  button.textContent = mode === 'dark' ? 'LIGHT' : 'DARK';
  button.title = `Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`;
}

/* ------------------------------- routing ------------------------------- */

function setView(name) {
  currentView = name;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  if (name === 'live') live.onShow();
  if (name === 'source') source.onShow(state);
  if (name === 'source') ladderSetup.onShow(state);
}

/* -------------------------------- toasts -------------------------------- */

export function toast(message, kind = '') {
  const el = h('div.toast', { text: message, class: kind ? `is-${kind}` : '' });
  $('#toast-stack').append(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 260);
  }, kind === 'error' ? 6000 : 3400);
}

/* ------------------------------ live status ------------------------------ */

function renderStatus() {
  if (!state) return;
  const pill = $('#live-pill');
  const label = pill.querySelector('.live-label');
  const connected = state.slots.filter((s) => s.enabled && (s.health === 'connected' || s.health === 'manual'));
  const stale = state.slots.filter((s) => s.enabled && (s.health === 'stale' || s.health === 'error'));

  pill.classList.toggle('is-live', connected.length > 0 && stale.length === 0);
  pill.classList.toggle('is-stale', stale.length > 0);

  if (!state.slots.some((s) => s.enabled)) {
    label.textContent = 'STANDBY';
    $('#live-age').textContent = '';
  } else if (stale.length) {
    label.textContent = `${connected.length}/${connected.length + stale.length} FEEDS`;
    $('#live-age').textContent = age(state.lastTickAt);
  } else {
    label.textContent = 'LIVE';
    $('#live-age').textContent = age(state.lastTickAt);
  }

  const round = (state.settings.roundLabel || '').trim();
  $('#brand-sub').textContent = round ? round.toUpperCase() : 'GAME DAY CONTROL';
}

/* ------------------------------- bootstrap ------------------------------- */

function apply(snapshot, events = []) {
  state = snapshot;
  renderStatus();
  live.render(state, events);
  if (currentView === 'source') source.render(state);
  if (currentView === 'source') ladderSetup.render(state);
}

async function init() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) setView(tab.dataset.view);
  });

  $('#fullscreen-btn').addEventListener('click', () => window.api.toggleFullscreen());
  $('#overlay-hide').addEventListener('click', async () => {
    const hidden = await window.api.overlay.toggle();
    const button = $('#overlay-hide');
    button.textContent = hidden ? 'SHOW' : 'HIDE';
    button.title = hidden ? 'Show the OBS overlay' : 'Hide the OBS overlay';
  });
  applyTheme(localStorage.getItem('live-ladder-theme') || 'dark');
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('live-ladder-theme', next);
    applyTheme(next);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === '1') setView('source');
    if (e.key === '2') setView('source');
    if (e.key === '3') setView('live');
    if (e.key === 'F11') { e.preventDefault(); window.api.toggleFullscreen(); }
  });

  await source.init({ toast });
  ladderSetup.init({ toast, goToSource: () => setView('source') });
  live.init({ toast });

  window.api.onState(({ snapshot, events }) => apply(snapshot, events));

  const snapshot = await window.api.getState();
  apply(snapshot);

  // Ages are relative — tick the cheap text once a second without re-rendering.
  setInterval(() => {
    renderStatus();
    live.tickAges(state);
    if (currentView === 'source') source.tickAges(state);
  }, 1000);

  setView(snapshot.ladderMeta.clubCount ? 'live' : 'source');
}

init();
