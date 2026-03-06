/**
 * tiny-empire/client/js/net.js
 *
 * Networking layer:
 *   REST — auth (register/login/resume) and save/load endpoints.
 *   WS   — app-level keepalive only ({ type:'PING' } / { type:'PONG' }).
 *           Game state is NEVER sent over WS.
 *
 * Token transport:
 *   Primary: Authorization: Bearer <token> header.
 *   Fallback: token field in JSON body (harbors-edge compatibility).
 *   Token stored in localStorage key 'te_token'.
 *
 * Autosave:
 *   Every 3 minutes if state.dirty === true.
 *   Immediate save on major events (configurable registry).
 *   Exponential backoff on failure.
 *   HUD status: saving / saved / error / offline.
 */
(function () {
  'use strict';
  const TE = window.TinyEmpire = window.TinyEmpire || {};

  const TOKEN_KEY = 'te_token';
  const API_BASE = location.pathname.includes('/tiny-empire/') ? '/tiny-empire/api' : '/api';
  const API_BASES = [API_BASE];
  const LOCAL_SAVE_VERSION = 1;
  const LOCAL_BACKUP_INTERVAL_MS = 30 * 1000;
  const API_HEALTH_POLL_MS = 15 * 1000;
  const SAVE_TARGET_BYTES = 220 * 1024;
  const DEBUG_MODE = (localStorage.getItem('te_debug') === '1') || /[?&]debug=1(?:&|$)/.test(location.search);

  let wsConnected = false;
  let apiConnected = false;
  let apiHealthTimer = null;

  function updateConnectionIndicator() {
    TE.ui.setConnection(!!(wsConnected || apiConnected));
  }

  function localBackupKey() {
    const token = getToken() || 'anon';
    return `te_save_local_v${LOCAL_SAVE_VERSION}_${token.slice(0,16)}`;
  }

  function globalBackupKey() {
    return `te_save_local_v${LOCAL_SAVE_VERSION}_global`;
  }

  function persistLocalBackup() {
    if (!TE.serialise) return;
    try {
      const payload = TE.serialise();
      // Only persist well-formed serialised payloads to avoid writing
      // partial or invalid snapshots (which cause blank reloads).
      if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.saveSchemaVersion)) return;
      const wrapped = { savedAt: Date.now(), payload };
      // Store both a token-scoped backup and a global fallback so that
      // temporary token issues (or quick reloads) don't lose the local
      // snapshot. Global backup is only used as a best-effort fallback.
      localStorage.setItem(localBackupKey(), JSON.stringify(wrapped));
      try { localStorage.setItem(globalBackupKey(), JSON.stringify(wrapped)); } catch (_) {}
    } catch (_) {}
  }

  function loadLocalBackup() {
    try {
      // Prefer token-scoped backup, fall back to global backup if absent.
      let raw = localStorage.getItem(localBackupKey());
      if (!raw) raw = localStorage.getItem(globalBackupKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.payload) return null;
      const p = parsed.payload;
      // Validate minimal shape of the save payload before returning it.
      if (!p || typeof p !== 'object') return null;
      if (!Number.isFinite(p.saveSchemaVersion)) return null;
      if (!p.nest || typeof p.nest !== 'object') return null;
      if (!Array.isArray(p.ants) || !Array.isArray(p.resources)) return null;
      // Return the wrapper so callers can inspect `savedAt` along with payload
      // (useful to decide whether server or local snapshot is fresher).
      return parsed;
    } catch (_) {
      return null;
    }
  }

  /* ── token helpers ─────────────────────────────────────── */

  function getToken()    { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t)   { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken()  { localStorage.removeItem(TOKEN_KEY); }

  function authHeaders() {
    const t = getToken();
    const h = { 'Content-Type': 'application/json' };
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  }

  /* ── REST helpers ──────────────────────────────────────── */

  function responsePreview(raw) {
    return String(raw || '')
      .replace(/[^\x20-\x7E]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  async function requestJSON(method, endpoint, body) {
    let lastError = null;
    const attempts = [];
    for (const base of API_BASES) {
      const url = `${base}${endpoint}`;
      attempts.push(url);
      try {
        const res = await fetch(url, {
          method,
          headers: authHeaders(),
          body: (body === undefined) ? undefined : JSON.stringify(body),
        });
        const raw = await res.text();
        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('application/json')) {
          const preview = responsePreview(raw);
          throw new Error(`Non-JSON response from ${url} (${res.status} ${res.statusText}, content-type: ${contentType || 'unknown'}). Preview: ${preview}`);
        }
        const parsed = JSON.parse(raw);
        apiConnected = true;
        updateConnectionIndicator();
        return parsed;
      } catch (err) {
        lastError = err;
      }
    }
    apiConnected = false;
    updateConnectionIndicator();
    if (lastError) {
      lastError.message = `${lastError.message}. Attempts: ${attempts.join(', ')}`;
      throw lastError;
    }
    throw new Error(`Request failed for ${endpoint}. Attempts: ${attempts.join(', ')}`);
  }

  async function probeApiHealth() {
    try {
      const health = await get('/health');
      apiConnected = !!(health && health.ok);
    } catch (_) {
      apiConnected = false;
    }
    updateConnectionIndicator();
  }

  async function post(endpoint, body) {
    return requestJSON('POST', endpoint, body);
  }

  async function get(endpoint) {
    return requestJSON('GET', endpoint);
  }

  function ensureToken() {
    const token = getToken();
    if (!token) throw new Error('missing_token');
    return token;
  }

  async function authPost(endpoint, body) {
    ensureToken();
    return post(endpoint, body);
  }

  async function authGet(endpoint) {
    ensureToken();
    return get(endpoint);
  }

  /* ── auth API ──────────────────────────────────────────── */

  async function register(loginName, visibleName, password) {
    const r = await post('/register', { loginName, visibleName, password });
    if (r.ok && r.token) setToken(r.token);
    return r;
  }

  async function login(loginName, password) {
    const r = await post('/login', { loginName, password });
    if (r.ok && r.token) setToken(r.token);
    return r;
  }

  async function resume() {
    if (!getToken()) return { ok: false, reason: 'no_token' };
    const r = await authPost('/resume', {});
    if (!r.ok) clearToken();
    return r;
  }

  /* ── save / load API ───────────────────────────────────── */

  function jsonSizeBytes(value) {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).length;
    } catch (_) {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  function trimSavePayload(payload) {
    const out = JSON.parse(JSON.stringify(payload));
    if (!Array.isArray(out.ants)) out.ants = [];
    if (!Array.isArray(out.resources)) out.resources = [];

    let size = jsonSizeBytes(out);
    if (size <= SAVE_TARGET_BYTES) return out;

    while (size > SAVE_TARGET_BYTES && (out.ants.length > 100 || out.resources.length > 100)) {
      if (out.ants.length > 100) out.ants = out.ants.slice(0, Math.max(100, Math.floor(out.ants.length * 0.8)));
      if (out.resources.length > 100) out.resources = out.resources.slice(0, Math.max(100, Math.floor(out.resources.length * 0.8)));
      size = jsonSizeBytes(out);
    }

    if (size > SAVE_TARGET_BYTES) {
      out.ants = out.ants.slice(0, 100);
      out.resources = out.resources.slice(0, 100);
    }

    out.saveMeta = out.saveMeta || {};
    out.saveMeta.trimmedForTransport = true;
    out.saveMeta.targetBytes = SAVE_TARGET_BYTES;
    out.saveMeta.actualBytes = jsonSizeBytes(out);
    return out;
  }

  async function saveGame() {
    const payload = trimSavePayload(TE.serialise());
    return authPost('/save', payload);
  }

  async function saveNow() {
    if (!TE.state || !getToken()) return { ok: false, reason: 'missing_token' };
    persistLocalBackup();
    const result = await saveGame();
    if (result && result.ok) {
      TE.state.dirty = false;
      persistLocalBackup();
    }
    return result;
  }

  async function loadLatest() {
    return authGet('/save/latest');
  }

  async function listSaves() {
    return authGet('/saves');
  }

  function saveErrorMessage(err) {
    const message = String((err && err.message) || err || 'save_failed');
    if (DEBUG_MODE) return message;
    if (/missing_token|invalid_token|401|403/i.test(message)) return 'Session expired. Please log in again.';
    if (/413|payload_too_large|request entity too large|too large/i.test(message)) return 'Save snapshot too large. Continuing with local backup.';
    if (/502|503|504|gateway|upstream|nginx|non-json/i.test(message)) return 'Server save unavailable. Using local backup.';
    return 'Save failed. Using local backup.';
  }

  /* ── major-event registry ──────────────────────────────── */
  /**
   * Easy-to-edit hook list. Add or remove event names here
   * to control which events trigger an immediate save.
   */
  const MajorEventRegistry = new Set([
    'upgradePurchased',
    'upgradeApplied',
    'queenUpgraded',
    'researchCompleted',
    'buildingConstructed',
    'colonyLost',
  ]);

  /** Called by game systems: TE.majorEvent('eventName'). */
  const MAJOR_EVENT_SAVE_COOLDOWN_MS = 60 * 1000;
  let lastMajorSaveAt = 0;
  function majorEvent(name) {
    if (!MajorEventRegistry.has(name)) return;
    const now = Date.now();
    if (now - lastMajorSaveAt < MAJOR_EVENT_SAVE_COOLDOWN_MS) return;
    lastMajorSaveAt = now;
    scheduleSave(true);
  }

  /* ── autosave engine ───────────────────────────────────── */

  const AUTOSAVE_MS   = 3 * 60 * 1000;  // 3 minutes
  const BACKOFF_INIT  = 5000;            // 5 s initial retry
  const BACKOFF_MAX   = 10 * 60 * 1000;  // 10 min cap

  let autosaveTimer   = null;
  let localBackupTimer = null;
  let backoffDelay    = 0;
  let backoffUntilMs  = 0;
  let saveInFlight    = false;

  function startAutosave() {
    if (autosaveTimer) return;
    autosaveTimer = setInterval(() => scheduleSave(false), AUTOSAVE_MS);
    localBackupTimer = setInterval(() => {
      if (TE.state && TE.state.dirty) persistLocalBackup();
    }, LOCAL_BACKUP_INTERVAL_MS);
  }

  function stopAutosave() {
    if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
    if (localBackupTimer) { clearInterval(localBackupTimer); localBackupTimer = null; }
  }

  async function scheduleSave(immediate) {
    const now = Date.now();
    if (now < backoffUntilMs) return;
    if (saveInFlight) return;
    if (!TE.state.dirty) return;
    if (!getToken()) return;

    persistLocalBackup();

    saveInFlight = true;
    TE.ui.setSaveStatus('saving');
    try {
      const result = await saveGame();
      if (result.ok) {
        TE.state.dirty = false;
        persistLocalBackup();
        backoffDelay = 0;
        backoffUntilMs = 0;
        TE.ui.setSaveStatus('saved', result.savedAt ? `server ${result.savedAt}` : 'server');
      } else {
        throw new Error(result.reason || 'save_failed');
      }
    } catch (err) {
      backoffDelay = backoffDelay ? Math.min(backoffDelay * 2, BACKOFF_MAX) : BACKOFF_INIT;
      backoffUntilMs = Date.now() + backoffDelay;
      TE.ui.setSaveStatus('error', saveErrorMessage(err));
      // Retry with backoff
      setTimeout(() => scheduleSave(true), backoffDelay);
    } finally {
      saveInFlight = false;
    }
  }

  /* ── WebSocket keepalive ───────────────────────────────── */
  /*
   * App-level JSON messages only (NOT protocol-level ping frames).
   * Server sends { type: 'PING' }, client replies { type: 'PONG' }.
   */

  let ws = null;
  let wsReconnectTimer = null;
  const WS_PATHS = location.pathname.includes('/tiny-empire/')
    ? ['/tiny-empire/ws', '/tiny-empire/', '/ws', '/']
    : ['/ws', '/'];
  let wsPathIndex = 0;

  function connectWS() {
    if (ws) return;
    if (!apiHealthTimer) {
      probeApiHealth();
      apiHealthTimer = setInterval(probeApiHealth, API_HEALTH_POLL_MS);
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsPath = WS_PATHS[Math.max(0, Math.min(wsPathIndex, WS_PATHS.length - 1))];
    ws = new WebSocket(`${proto}://${location.host}${wsPath}`);

    ws.addEventListener('open', () => {
      wsConnected = true;
      updateConnectionIndicator();
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      // Server sends PING; we reply PONG
      if (msg && msg.type === 'PING') {
        try { ws.send(JSON.stringify({ type: 'PONG' })); } catch (_) { /* ignore */ }
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      wsConnected = false;
      updateConnectionIndicator();
      // Reconnect after 3 s
      if (!wsReconnectTimer) {
        wsReconnectTimer = setTimeout(() => {
          wsPathIndex = (wsPathIndex + 1) % WS_PATHS.length;
          connectWS();
        }, 3000);
      }
    });

    ws.addEventListener('error', () => {
      wsConnected = false;
      updateConnectionIndicator();
      try { ws.close(); } catch (_) { /* ignore */ }
    });
  }

  /* ── exports ───────────────────────────────────────────── */

  TE.net = {
    register, login, resume,
    saveGame, saveNow, loadLatest, listSaves,
    startAutosave, stopAutosave,
    connectWS,
    getToken, setToken, clearToken,
    persistLocalBackup, loadLocalBackup,
    MajorEventRegistry,
  };
  TE.majorEvent = majorEvent;
})();
