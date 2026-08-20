'use strict';

/**
 * Renders build/icon.svg into build/icon.ico (multi-size) and build/icon.png.
 *
 * Uses Electron's own Chromium to rasterise, so there is no image toolchain to
 * install. Run with:  npm run icon
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const SVG = path.join(BUILD, 'icon.svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const MAX = Math.max(...SIZES);

/** Pack PNG buffers into an .ico (PNG-compressed entries, valid on Windows Vista+). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const at = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 0);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    dir.writeUInt8(0, at + 2);     // palette entries
    dir.writeUInt8(0, at + 3);     // reserved
    dir.writeUInt16LE(1, at + 4);  // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let win;
  try {
    const svg = fs.readFileSync(SVG, 'utf8');
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden}
        #stage{width:${MAX}px;height:${MAX}px}
        #stage svg{display:block;width:100%;height:100%}
      </style></head><body><div id="stage">${svg}</div></body></html>`;

    const tmp = path.join(os.tmpdir(), `live-ladder-icon-${process.pid}.html`);
    fs.writeFileSync(tmp, page, 'utf8');

    win = new BrowserWindow({
      width: MAX,
      height: MAX,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      resizable: true,
      webPreferences: { offscreen: true, sandbox: true }
    });

    await win.loadFile(tmp);
    await sleep(300);

    const entries = [];
    for (const size of SIZES) {
      // Render at full resolution and let Chromium downsample the capture —
      // gradients and the drop shadow survive far better than re-laying out.
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: MAX, height: MAX });
      const png = image.resize({ width: size, height: size, quality: 'best' }).toPNG();
      entries.push({ size, png });
      process.stdout.write(`  rendered ${size}x${size} (${png.length} bytes)\n`);
    }

    fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(entries));
    fs.writeFileSync(path.join(BUILD, 'icon.png'), entries.find((e) => e.size === 256).png);
    fs.unlinkSync(tmp);

    process.stdout.write('  wrote build/icon.ico and build/icon.png\n');
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error('icon build failed:', err && err.message ? err.message : err);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});
