'use strict';

/**
 * Background browser engine.
 *
 * The brief asks for a real Chromium engine running invisibly so that
 * JavaScript-rendered scoring pages can be read. Electron already ships
 * Chromium, so instead of pulling in a second copy via Playwright we drive
 * offscreen BrowserWindows: same engine, no extra 300MB download, and
 * guaranteed never to flash a window on screen (show:false + offscreen paint).
 *
 * This is the FALLBACK path. Both supported sources expose JSON endpoints that
 * the pages themselves call, so the normal path is a plain HTTP read and this
 * pool usually stays empty.
 */

const { BrowserWindow } = require('electron');

const RELOAD_AFTER_MS = 5 * 60 * 1000; // refresh a long-lived page every 5 min
const LOAD_TIMEOUT_MS = 25000;

/** @type {Map<string, {win: Electron.BrowserWindow, url: string, loadedAt: number, loading: Promise<void>|null}>} */
const pages = new Map();

function createWindow() {
  return new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: false,
    skipTaskbar: true,
    width: 1280,
    height: 900,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      images: false,
      webgl: false
    }
  });
}

function loadUrl(win, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onOk);
      win.webContents.removeListener('did-fail-load', onFail);
      err ? reject(err) : resolve();
    };
    const onOk = () => done(null);
    const onFail = (_e, code, desc) => {
      // -3 is ERR_ABORTED, which fires for in-page redirects we do not care about
      if (code === -3) return;
      done(new Error(`Page load failed (${code}) ${desc}`));
    };
    const timer = setTimeout(() => done(new Error('Page load timed out')), LOAD_TIMEOUT_MS);

    win.webContents.once('did-finish-load', onOk);
    win.webContents.on('did-fail-load', onFail);
    win.loadURL(url).catch(done);
  });
}

/**
 * Run an extractor in the page at `url`, keeping the page alive between calls
 * so client-side polling keeps the DOM fresh.
 *
 * @param {string} key     stable id (the game slot id) so each source gets its own page
 * @param {string} url     page to load
 * @param {string} script  a JS expression evaluated in the page; must return JSON-safe data
 * @param {{settleMs?:number}} opts
 */
async function evaluate(key, url, script, { settleMs = 1200 } = {}) {
  let entry = pages.get(key);

  if (entry && (entry.win.isDestroyed() || entry.url !== url)) {
    destroy(key);
    entry = null;
  }

  if (!entry) {
    const win = createWindow();
    entry = { win, url, loadedAt: 0, loading: null };
    pages.set(key, entry);
    entry.loading = loadUrl(win, url).then(
      () => {
        entry.loadedAt = Date.now();
        entry.loading = null;
      },
      (err) => {
        entry.loading = null;
        throw err;
      }
    );
    await entry.loading;
    await new Promise((r) => setTimeout(r, settleMs));
  } else if (entry.loading) {
    await entry.loading;
  } else if (Date.now() - entry.loadedAt > RELOAD_AFTER_MS) {
    entry.loading = loadUrl(entry.win, url).then(
      () => {
        entry.loadedAt = Date.now();
        entry.loading = null;
      },
      (err) => {
        entry.loading = null;
        throw err;
      }
    );
    await entry.loading;
    await new Promise((r) => setTimeout(r, settleMs));
  }

  if (entry.win.isDestroyed()) throw new Error('Background page was closed');
  return entry.win.webContents.executeJavaScript(script, true);
}

function destroy(key) {
  const entry = pages.get(key);
  if (!entry) return;
  pages.delete(key);
  try {
    if (!entry.win.isDestroyed()) entry.win.destroy();
  } catch {
    /* window already gone */
  }
}

function destroyAll() {
  for (const key of [...pages.keys()]) destroy(key);
}

function activeCount() {
  return pages.size;
}

module.exports = { evaluate, destroy, destroyAll, activeCount };
