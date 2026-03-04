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

    // Try loading latest save from server
    const saved = await TE.net.loadLatest();
    if (saved && saved.ok && saved.save) {
      TE.deserialise(saved.save);
    } else {
      TE.initNew();
    }

    TE.net.connectWS();
    TE.net.startAutosave();
    startSimulation();
    startRender();
    console.log('Tiny Empire: ready');
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
    TE.renderer.init(canvas);
    TE.input.init(canvas);
    TE.ui.init();

    document.getElementById('btn-login').addEventListener('click', onLogin);
    document.getElementById('btn-register').addEventListener('click', onRegister);

    // Auto-resume if token exists
    if (TE.net.getToken()) {
      tryResume();
    } else {
      showAuth();
    }
  });
})();
