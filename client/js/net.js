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

  async function requestJSON(method, endpoint, body) {
    const url = `${API_BASE}${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: authHeaders(),
      body: (body === undefined) ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      const preview = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new Error(`Expected JSON from ${url}, got ${res.status} ${res.statusText}. Response preview: ${preview}`);
    }
    try {
      return JSON.parse(raw);
    } catch (_err) {
      const preview = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new Error(`Invalid JSON from ${url}. Response preview: ${preview}`);
    }
  }

  async function post(endpoint, body) {
    return requestJSON('POST', endpoint, body);
  }

  async function get(endpoint) {
    return requestJSON('GET', endpoint);
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
    const token = getToken();
    if (!token) return { ok: false, reason: 'no_token' };
    const r = await post('/resume', { token });
    if (!r.ok) clearToken();
    return r;
  }

  /* ── save / load API ───────────────────────────────────── */

  async function saveGame() {
    const payload = TE.serialise();
    return post('/save', payload);
  }

  async function loadLatest() {
    return get('/save/latest');
  }

  async function listSaves() {
    return get('/saves');
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
  let backoffDelay    = 0;
  let backoffUntilMs  = 0;
  let saveInFlight    = false;

  function startAutosave() {
    if (autosaveTimer) return;
    autosaveTimer = setInterval(() => scheduleSave(false), AUTOSAVE_MS);
  }

  function stopAutosave() {
    if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
  }

  async function scheduleSave(immediate) {
    const now = Date.now();
    if (now < backoffUntilMs) return;
    if (saveInFlight) return;
    if (!TE.state.dirty) return;
    if (!getToken()) return;

    saveInFlight = true;
    TE.ui.setSaveStatus('saving');
    try {
      const result = await saveGame();
      if (result.ok) {
        TE.state.dirty = false;
        backoffDelay = 0;
        backoffUntilMs = 0;
        TE.ui.setSaveStatus('saved', result.savedAt || '');
      } else {
        throw new Error(result.reason || 'save_failed');
      }
    } catch (err) {
      backoffDelay = backoffDelay ? Math.min(backoffDelay * 2, BACKOFF_MAX) : BACKOFF_INIT;
      backoffUntilMs = Date.now() + backoffDelay;
      TE.ui.setSaveStatus('error', err.message);
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

  function connectWS() {
    if (ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      TE.ui.setConnection(true);
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
      TE.ui.setConnection(false);
      // Reconnect after 3 s
      if (!wsReconnectTimer) wsReconnectTimer = setTimeout(connectWS, 3000);
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch (_) { /* ignore */ }
    });
  }

  /* ── exports ───────────────────────────────────────────── */

  TE.net = {
    register, login, resume,
    saveGame, loadLatest, listSaves,
    startAutosave, stopAutosave,
    connectWS,
    getToken, setToken, clearToken,
    MajorEventRegistry,
  };
  TE.majorEvent = majorEvent;
})();
