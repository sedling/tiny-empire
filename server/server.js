/**
 * tiny-empire/server/server.js
 *
 * Same-origin Node server: serves static client files AND REST API endpoints,
 * plus a WebSocket used only for app-level keepalive (PING/PONG).
 *
 * Compatibility references:
 *   harbors-edge/server/server.js        — atomicWriteFile, rate limiter, WS PING/PONG
 *   harbors-edge/server/src/auth.js      — register/login/resume, token format
 *   harbors-edge/server/src/ids.js       — token generation (prefix 't' + 24 hex)
 *   harbors-edge/server/src/protocol.json — PING / PONG message type strings
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const auth      = require('./src/auth');
const saveUtils = require('./src/saveUtils');

const PORT          = parseInt(process.env.PORT, 10) || 3010;
const CLIENT_DIR    = path.join(__dirname, '..', 'client');
const WS_PING_MS    = 30_000;   // server sends {type:'PING'} every ~30 s
const saveLimiter   = new saveUtils.RateLimiter(6, 60_000);  // 6 saves/min per key

/* ── MIME helpers ────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function mime(ext) { return MIME[ext] || 'application/octet-stream'; }

/* ── HTTP helpers ────────────────────────────────────────── */

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('payload_too_large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Extract Bearer token from Authorization header OR JSON body fallback.
 * Primary: Authorization: Bearer <token>
 * Fallback: { token: '...' } in body (compatibility with harbors-edge WS-based flow).
 */
function extractToken(req, body) {
  const hdr = req.headers['authorization'] || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice(7).trim();
  if (body && typeof body === 'object' && typeof body.token === 'string') return body.token;
  return null;
}

/* ── REST routing ────────────────────────────────────────── */

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  try {
    /* ── auth endpoints ──────────────────────────────────── */
    if (route === '/api/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 4096));
      const result = auth.register(body.visibleName, body.loginName, body.password);
      return sendJSON(res, result.ok ? 200 : 400, result);
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 4096));
      const result = auth.login(body.loginName, body.password);
      return sendJSON(res, result.ok ? 200 : 401, result);
    }

    if (route === '/api/resume' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 4096));
      const token = extractToken(req, body);
      if (!token) return sendJSON(res, 401, { ok: false, reason: 'missing_token' });
      const result = auth.resume(token);
      return sendJSON(res, result.ok ? 200 : 401, result);
    }

    if (route === '/api/health' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, service: 'tiny-empire', status: 'healthy' });
    }

    /* ── save endpoints ──────────────────────────────────── */
    if (route === '/api/save' && req.method === 'POST') {
      const rawBody = await readBody(req, saveUtils.MAX_PAYLOAD_BYTES);
      if (Buffer.byteLength(rawBody, 'utf8') > saveUtils.MAX_PAYLOAD_BYTES) {
        return sendJSON(res, 413, { ok: false, reason: 'payload_too_large' });
      }
      let body;
      try { body = JSON.parse(rawBody); } catch (_) {
        return sendJSON(res, 400, { ok: false, reason: 'invalid_json' });
      }
      const token = extractToken(req, body);
      if (!token) return sendJSON(res, 401, { ok: false, reason: 'missing_token' });
      const session = auth.resolveToken(token);
      if (!session.ok) return sendJSON(res, 401, { ok: false, reason: session.reason });

      // Rate limit per accountId
      if (!saveLimiter.allow(session.accountId)) {
        return sendJSON(res, 429, { ok: false, reason: 'rate_limited' });
      }

      // Extract the save payload (strip token if present in body so it's not saved)
      const payload = body.payload || body;
      if (payload.token) delete payload.token;

      // Migrate if needed
      let migrated;
      try { migrated = saveUtils.migrateSave(payload); } catch (err) {
        return sendJSON(res, 400, { ok: false, reason: `migration_error: ${err.message}` });
      }

      // Validate
      const v = saveUtils.validateSavePayload(migrated);
      if (!v.ok) return sendJSON(res, 400, v);

      // Write + prune
      const result = saveUtils.writeSave(session.accountId, migrated);
      return sendJSON(res, 200, result);
    }

    if (route === '/api/saves' && req.method === 'GET') {
      const token = extractToken(req, null);
      if (!token) return sendJSON(res, 401, { ok: false, reason: 'missing_token' });
      const session = auth.resolveToken(token);
      if (!session.ok) return sendJSON(res, 401, { ok: false, reason: session.reason });
      const files = saveUtils.listSaves(session.accountId);
      return sendJSON(res, 200, { ok: true, saves: files });
    }

    if (route === '/api/save/latest' && req.method === 'GET') {
      const token = extractToken(req, null);
      if (!token) return sendJSON(res, 401, { ok: false, reason: 'missing_token' });
      const session = auth.resolveToken(token);
      if (!session.ok) return sendJSON(res, 401, { ok: false, reason: session.reason });
      const latest = saveUtils.loadLatestSave(session.accountId);
      if (!latest) return sendJSON(res, 404, { ok: false, reason: 'no_saves' });
      return sendJSON(res, 200, { ok: true, save: latest.save, savedAt: latest.savedAt });
    }

    // GET /api/save/:timestamp
    const saveMatch = route.match(/^\/api\/save\/(\d{8}-\d{6})$/);
    if (saveMatch && req.method === 'GET') {
      const token = extractToken(req, null);
      if (!token) return sendJSON(res, 401, { ok: false, reason: 'missing_token' });
      const session = auth.resolveToken(token);
      if (!session.ok) return sendJSON(res, 401, { ok: false, reason: session.reason });
      const save = saveUtils.loadSave(session.accountId, saveMatch[1]);
      if (!save) return sendJSON(res, 404, { ok: false, reason: 'save_not_found' });
      return sendJSON(res, 200, { ok: true, save });
    }

    return sendJSON(res, 404, { ok: false, reason: 'not_found' });

  } catch (err) {
    if (err.message === 'payload_too_large') {
      return sendJSON(res, 413, { ok: false, reason: 'payload_too_large' });
    }
    console.error('API error:', err);
    return sendJSON(res, 500, { ok: false, reason: 'internal_error' });
  }
}

/* ── static file serving ─────────────────────────────────── */

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/tiny-empire/client/')) {
    pathname = pathname.slice('/tiny-empire/client/'.length);
  } else if (pathname.startsWith('/tiny-empire/')) {
    pathname = pathname.slice('/tiny-empire/'.length);
  } else if (pathname.startsWith('/client/')) {
    pathname = pathname.slice('/client/'.length);
  }

  pathname = pathname.replace(/^\/+/, '');
  let filePath = path.join(CLIENT_DIR, pathname);
  const clientRoot = path.resolve(CLIENT_DIR);
  let resolvedPath = path.resolve(filePath);

  // Prevent directory traversal
  if (resolvedPath !== clientRoot && !resolvedPath.startsWith(clientRoot + path.sep)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  // Default to index.html
  if (!pathname || pathname.endsWith('/')) {
    filePath = path.join(filePath, 'index.html');
    resolvedPath = path.resolve(filePath);
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404); res.end('Not Found');
      return;
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mime(ext),
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(resolvedPath).pipe(res);
  });
}

/* ── HTTP server ─────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/tiny-empire/api' || url.pathname.startsWith('/tiny-empire/api/')) {
    req.url = url.pathname.replace('/tiny-empire', '') + (url.search || '');
    return handleAPI(req, res);
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleAPI(req, res);
  serveStatic(req, res);
});

/* ── WebSocket keepalive ─────────────────────────────────── */
/*
 * App-level JSON keepalive (NOT WebSocket protocol-level ping frames).
 * Server periodically sends { type: 'PING' }.
 * Client must reply with { type: 'PONG' }.
 * Compatible with harbors-edge/server/src/protocol.json PING/PONG values.
 */

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws._alive = true;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg && msg.type === 'PONG') {
      ws._alive = true;
    }
    // No other messages expected over WS; game state is never sent here.
  });

  ws.on('close', () => { ws._alive = false; });
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) { ws.terminate(); continue; }
    ws._alive = false;
    try { ws.send(JSON.stringify({ type: 'PING' })); } catch (_) { /* ignore */ }
  }
}, WS_PING_MS);

wss.on('close', () => clearInterval(pingInterval));

/* ── start ───────────────────────────────────────────────── */

server.listen(PORT, () => {
  console.log(`Tiny Empire server listening on port ${PORT}`);
  console.log(`Client served from ${CLIENT_DIR}`);
});

/* ── test helpers (used by server.test.js) ───────────────── */
module.exports = { server, wss, saveLimiter };
