/**
 * tiny-empire/client/js/boot.js
 *
 * Entry point — auth handshake, load/init state, start loops.
 *
 * Fixed timestep simulation: 20 ticks/sec (50 ms per tick).
 * Rendering: requestAnimationFrame (decoupled from sim).
 */
(function () {
  'use strict';
  const TE = window.TinyEmpire;

  const TICK_RATE = 20;
  const TICK_MS   = 1000 / TICK_RATE;

  let settingsMenuEl = null;
  let settingsBackdropEl = null;

  function showSettings() {
    if (!settingsMenuEl) return;
    simRunning = false;
    if (settingsBackdropEl) {
      settingsBackdropEl.classList.remove('hidden');
      settingsBackdropEl.setAttribute('aria-hidden', 'false');
    }
    settingsMenuEl.classList.remove('hidden');
    settingsMenuEl.setAttribute('aria-hidden', 'false');
  }

  function hideSettings() {
    if (!settingsMenuEl) return;
    settingsMenuEl.classList.add('hidden');
    settingsMenuEl.setAttribute('aria-hidden', 'true');
    if (settingsBackdropEl) {
      settingsBackdropEl.classList.add('hidden');
      settingsBackdropEl.setAttribute('aria-hidden', 'true');
    }
    const authOverlayEl = document.getElementById('auth-overlay');
    if (authOverlayEl && authOverlayEl.classList.contains('hidden')) {
      startSimulation();
    }
  }

  /* ── auth UI wiring ────────────────────────────────────── */

  function showAuth()  { document.getElementById('auth-overlay').classList.remove('hidden'); document.getElementById('hud').style.display = 'none'; }
  function hideAuth()  { document.getElementById('auth-overlay').classList.add('hidden');    document.getElementById('hud').style.display = ''; }
  function authError(msg) { document.getElementById('auth-error').textContent = msg; }

  async function tryResume() {
    const r = await TE.net.resume();
    if (r.ok) { await enterGame(); return; }
    showAuth();
  }

  async function onLogin() {
    authError('');
    const login = document.getElementById('auth-login').value.trim();
    const pass  = document.getElementById('auth-pass').value;
    if (!login || !pass) { authError('Fill in login name and password.'); return; }
    const r = await TE.net.login(login, pass);
    if (!r.ok) { authError(r.reason || 'Login failed'); return; }
    await enterGame();
  }

  async function onRegister() {
    authError('');
    const login   = document.getElementById('auth-login').value.trim();
    const visible = document.getElementById('auth-visible').value.trim() || login;
    const pass    = document.getElementById('auth-pass').value;
    if (!login || !pass) { authError('Fill in login name and password.'); return; }
    const r = await TE.net.register(login, visible, pass);
    if (!r.ok) { authError(r.reason || 'Registration failed'); return; }
    await enterGame();
  }

  /* ── enter game ────────────────────────────────────────── */

  async function enterGame() {
    hideAuth();

    let serverSave = null;
    let localSave = null;

    try {
      const saved = await TE.net.loadLatest();
      if (saved && saved.ok && saved.save) serverSave = saved.save;
    } catch (_err) {
      // server save unavailable (e.g., proxy 502); fallback to local backup below
    }

    localSave = TE.net.loadLocalBackup();

    if (serverSave && localSave) {
      const serverTick = Number(serverSave.gameTick || 0);
      const localTick  = Number(localSave.gameTick || 0);
      if (localTick >= serverTick) {
        TE.deserialise(localSave);
        TE.ui.setSaveStatus('saved', 'local backup');
      } else {
        TE.deserialise(serverSave);
      }
    } else if (localSave) {
      TE.deserialise(localSave);
      TE.ui.setSaveStatus('saved', 'local backup');
    } else if (serverSave) {
      TE.deserialise(serverSave);
    } else {
      TE.initNew();
    }

    TE.net.connectWS();
    TE.net.startAutosave();
    startSimulation();
    startRender();
    hideSettings();
    console.log('Tiny Empire: ready');
  }

  async function onManualSave() {
    hideSettings();
    TE.ui.setSaveStatus('saving');
    try {
      const result = await TE.net.saveNow();
      if (result && result.ok) {
        TE.ui.setSaveStatus('saved', result.savedAt ? `server ${result.savedAt}` : 'server');
      } else {
        TE.ui.setSaveStatus('error', 'Save failed. Using local backup.');
      }
    } catch (_) {
      TE.ui.setSaveStatus('error', 'Save failed. Using local backup.');
    }
  }

  async function onManualLoad() {
    hideSettings();
    let serverSave = null;
    let localSave = null;
    try {
      const saved = await TE.net.loadLatest();
      if (saved && saved.ok && saved.save) serverSave = saved.save;
    } catch (_) {}
    localSave = TE.net.loadLocalBackup();

    if (serverSave && localSave) {
      if (Number(localSave.gameTick || 0) >= Number(serverSave.gameTick || 0)) {
        TE.deserialise(localSave);
        TE.ui.setSaveStatus('saved', 'local backup');
      } else {
        TE.deserialise(serverSave);
        TE.ui.setSaveStatus('saved', 'server load');
      }
    } else if (localSave) {
      TE.deserialise(localSave);
      TE.ui.setSaveStatus('saved', 'local backup');
    } else if (serverSave) {
      TE.deserialise(serverSave);
      TE.ui.setSaveStatus('saved', 'server load');
    } else {
      TE.ui.setSaveStatus('error', 'No save found.');
    }
  }

  function onLogout() {
    TE.net.clearToken();
    TE.net.stopAutosave();
    simRunning = false;
    showAuth();
    hideSettings();
  }

  /* ── simulation loop (fixed timestep) ──────────────────── */

  let simRunning = false;
  let lastSimTime = 0;
  let accumulator = 0;

  function startSimulation() {
    if (simRunning) return;
    simRunning  = true;
    lastSimTime = performance.now();
    accumulator = 0;
    requestAnimationFrame(simFrame);
  }

  function simFrame(now) {
    if (!simRunning) return;
    const delta = now - lastSimTime;
    lastSimTime = now;
    accumulator += delta;

    // Catch-up: run as many fixed ticks as needed
    while (accumulator >= TICK_MS) {
      TE.gameTick();   // game.js tick (advances state.gameTick)
      accumulator -= TICK_MS;
    }

    requestAnimationFrame(simFrame);
  }

  /* ── render loop ───────────────────────────────────────── */

  function startRender() {
    function frame() {
      TE.renderer.draw();
      TE.ui.update();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ── init ──────────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('game-canvas');
    settingsMenuEl = document.getElementById('settings-menu');
    settingsBackdropEl = document.getElementById('settings-backdrop');

    TE.renderer.init(canvas);
    TE.input.init(canvas);
    TE.ui.init();

    window.addEventListener('pagehide', () => TE.net.persistLocalBackup());
    window.addEventListener('beforeunload', () => TE.net.persistLocalBackup());

    document.getElementById('btn-login').addEventListener('click', onLogin);
    document.getElementById('btn-register').addEventListener('click', onRegister);
    document.getElementById('settings-btn').addEventListener('click', () => {
      if (!settingsMenuEl) return;
      if (settingsMenuEl.classList.contains('hidden')) showSettings(); else hideSettings();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const authOverlayEl = document.getElementById('auth-overlay');
      if (authOverlayEl && !authOverlayEl.classList.contains('hidden')) return;
      if (!settingsMenuEl) return;
      if (settingsMenuEl.classList.contains('hidden')) showSettings(); else hideSettings();
    });
    document.getElementById('menu-resume').addEventListener('click', hideSettings);
    document.getElementById('menu-save').addEventListener('click', onManualSave);
    document.getElementById('menu-load').addEventListener('click', onManualLoad);
    document.getElementById('menu-logout').addEventListener('click', onLogout);
    if (settingsBackdropEl) {
      settingsBackdropEl.addEventListener('click', hideSettings);
    }

    // Auto-resume if token exists
    if (TE.net.getToken()) {
      tryResume();
    } else {
      showAuth();
    }
  });
})();
