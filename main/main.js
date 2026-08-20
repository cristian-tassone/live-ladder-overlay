'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, ipcMain, shell, Menu, screen } = require('electron');

const store = require('./lib/store');
const browserPool = require('./lib/browserPool');
const { GameStore } = require('./engine/gameStore');
const { parseLadder } = require('./engine/ladderParser');
const adapters = require('./adapters');

// Background sources must keep polling while the operator is on another screen.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Test mode: simulated games, its own config folder so real game-day
// settings are never touched.
const TEST = process.argv.includes('--test') || process.argv.includes('--demo');
if (TEST) app.setPath('userData', path.join(app.getPath('userData'), 'test'));

// Own identity in the taskbar rather than inheriting Electron's.
app.setName('Live Ladder');
if (process.platform === 'win32') app.setAppUserModelId('cc.liveladder.app');

/** @type {BrowserWindow|null} */
let win = null;
const overlayClients = new Set();
const OVERLAY_PORT = 17842;
const CLOUD_URL = String(process.env.LIVE_LADDER_CLOUD_URL || '').replace(/\/+$/, '');
const CLOUD_TOKEN = String(process.env.LIVE_LADDER_CLOUD_TOKEN || '');
/** @type {BrowserWindow|null} */
/** @type {GameStore|null} */
let games = null;

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1600, sw),
    height: Math.min(980, sh),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#07080d',
    title: 'Live Ladder',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Never let the app navigate itself away or spawn windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

function broadcast(snapshot, events) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('state', { snapshot, events });
  }
  const message = `data: ${JSON.stringify({ snapshot, events })}\n\n`;
  for (const client of overlayClients) {
    try { client.write(message); } catch { overlayClients.delete(client); }
  }
  publishCloud(snapshot, events);
}

async function publishCloud(snapshot, events) {
  if (!CLOUD_URL || !CLOUD_TOKEN) return;
  try {
    await fetch(`${CLOUD_URL}/state`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
  } catch {
    // The local app must continue operating if the hosted relay is unavailable.
  }
}

function startOverlayServer() {
  const root = path.join(__dirname, '..', 'renderer');
  const mime = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(games.snapshot()));
      return;
    }
    if (pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ snapshot: games.snapshot(), events: [] })}\n\n`);
      overlayClients.add(res);
      req.on('close', () => overlayClients.delete(res));
      return;
    }
    const requested = pathname === '/' ? '/overlay.html' : pathname;
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(path.resolve(root))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  server.listen(OVERLAY_PORT, '127.0.0.1', () => console.log(`OVERLAY URL: http://127.0.0.1:${OVERLAY_PORT}/overlay.html`));
}

function seedTest() {
  const { SAMPLE_LADDER } = require('./adapters/demo');
  store.update((cfg) => {
    for (const slot of cfg.slots) {
      slot.type = 'test';
      slot.url = '';
      slot.manualMode = false;
      slot.mapping = { home: null, away: null };
    }
    cfg.settings.roundLabel = cfg.settings.roundLabel || 'TEST ROUND';
    cfg.settings.pollInterval = 3000;
  });
  const { clubs } = parseLadder(SAMPLE_LADDER);
  games.setLadder(clubs, SAMPLE_LADDER);
  games.connectAll();
}

app.whenReady().then(() => {
  games = new GameStore(store);
  games.on('state', broadcast);
  startOverlayServer();

  createWindow();
  win.webContents.on('console-message', (_e, _l, msg) => { if (msg.startsWith('WIDTHS') || msg.startsWith('LADDER') || msg.startsWith('SIDE')) console.log(msg); });
  if (TEST) setTimeout(seedTest, 400);

  ipcMain.handle('app:getState', () => games.snapshot());
  ipcMain.handle('app:sources', () => adapters.list());
  ipcMain.handle('app:detectType', (_e, url) => adapters.detectType(url));
  ipcMain.handle('app:testMode', () => { seedTest(); return games.snapshot(); });

  ipcMain.handle('slot:update', (_e, id, patch) => games.updateSlot(id, patch));
  ipcMain.handle('slot:connect', (_e, id) => games.connect(id));
  ipcMain.handle('slot:connectAll', () => games.connectAll());
  ipcMain.handle('slot:disconnect', (_e, id) => games.disconnect(id));
  ipcMain.handle('slot:clear', (_e, id) => games.clearSlot(id));
  ipcMain.handle('slot:manual', (_e, id, on) => games.setManual(id, on));

  ipcMain.handle('ladder:preview', (_e, text) => {
    try {
      return { ok: true, ...parseLadder(text) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('ladder:set', (_e, text) => {
    try {
      const { clubs, warnings } = parseLadder(text);
      games.setLadder(clubs, text);
      return { ok: true, clubs, warnings };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:poll', (_e, ms) => { games.setPollInterval(ms); return games.snapshot(); });
  ipcMain.handle('settings:round', (_e, label) => {
    store.update((cfg) => { cfg.settings.roundLabel = String(label || '').slice(0, 40); });
    games.push();
    return games.snapshot();
  });
  ipcMain.handle('log:clear', () => games.clearLog());

  ipcMain.handle('window:fullscreen', () => {
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  games?.shutdown();
  browserPool.destroyAll();
});
