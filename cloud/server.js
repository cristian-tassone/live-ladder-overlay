const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);
const TOKEN = String(process.env.LIVE_LADDER_TOKEN || '');
const ROOT = path.resolve(__dirname, '..', 'renderer');
const clients = new Set();
let latest = { ladder: [], games: [], updates: [] };

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf'
};

function writeJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!TOKEN) return false;
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  return supplied === TOKEN;
}

function broadcast(payload) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.write(message); } catch { clients.delete(client); }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy(new Error('Payload too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/overlay.html' : pathname;
  const file = path.resolve(ROOT, `.${requested}`);
  if (!file.startsWith(ROOT)) return writeJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return writeJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': pathname.endsWith('.html') ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (url.pathname === '/health') return writeJson(res, 200, { ok: true, clients: clients.size });
  if (url.pathname === '/state' && req.method === 'GET') return writeJson(res, 200, latest);
  if (url.pathname === '/state' && req.method === 'POST') {
    if (!authorized(req)) return writeJson(res, 401, { error: 'Unauthorized' });
    try {
      latest = JSON.parse(await readBody(req));
      broadcast({ snapshot: latest, events: [] });
      return writeJson(res, 200, { ok: true });
    } catch (error) {
      return writeJson(res, 400, { error: error.message || 'Invalid JSON' });
    }
  }
  if (url.pathname === '/command' && req.method === 'POST') {
    if (!authorized(req)) return writeJson(res, 401, { error: 'Unauthorized' });
    try {
      const command = JSON.parse(await readBody(req));
      broadcast({ command });
      return writeJson(res, 200, { ok: true });
    } catch (error) {
      return writeJson(res, 400, { error: error.message || 'Invalid JSON' });
    }
  }
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ snapshot: latest, events: [] })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return writeJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Live Ladder hosted overlay listening on ${PORT}`));
