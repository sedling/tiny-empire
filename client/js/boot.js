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
  let storeMenuEl = null;

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

  function showStore() {
    if (!storeMenuEl) return;
    simRunning = false;
    if (settingsBackdropEl) {
      settingsBackdropEl.classList.remove('hidden');
      settingsBackdropEl.setAttribute('aria-hidden', 'false');
    }
    storeMenuEl.classList.add('open');
    storeMenuEl.setAttribute('aria-hidden', 'false');
  }

  function hideStore() {
    if (!storeMenuEl) return;
    storeMenuEl.classList.remove('open');
    storeMenuEl.setAttribute('aria-hidden', 'true');
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

    let serverWrap = null;

    try {
      const saved = await TE.net.loadLatest();
      if (saved && saved.ok && saved.save) serverWrap = saved; // keep wrapper (includes savedAt)
    } catch (_err) {
      // server save unavailable (e.g., proxy 502); fallback to local backup below
    }

    const localWrap = TE.net.loadLocalBackup();
    // localWrap is either null or { savedAt, payload }
    const localPayload = localWrap ? localWrap.payload : null;
    const serverPayload = serverWrap ? serverWrap.save : null;

    if (serverPayload && localPayload) {
      // Prefer the freshest snapshot. If both sides provide timestamps,
      // compare them; otherwise fall back to comparing `gameTick`.
      const serverSavedAt = (serverWrap && typeof serverWrap.savedAt === 'string') ? Date.parse(serverWrap.savedAt) : (typeof serverWrap.savedAt === 'number' ? Number(serverWrap.savedAt) : 0);
      const localSavedAt = Number(localWrap.savedAt || 0);
      if (serverSavedAt && localSavedAt) {
        if (localSavedAt >= serverSavedAt) {
          TE.deserialise(localPayload);
          TE.ui.setSaveStatus('saved', 'local backup');
        } else {
          TE.deserialise(serverPayload);
        }
      } else {
        const serverTick = Number(serverPayload.gameTick || 0);
        const localTick  = Number(localPayload.gameTick || 0);
        if (localTick >= serverTick) {
          TE.deserialise(localPayload);
          TE.ui.setSaveStatus('saved', 'local backup');
        } else {
          TE.deserialise(serverPayload);
        }
      }
    } else if (localPayload) {
      TE.deserialise(localPayload);
      TE.ui.setSaveStatus('saved', 'local backup');
    } else if (serverPayload) {
      TE.deserialise(serverPayload);
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

  function onResetHeatmap() {
    if (TE.resetRoadHeatmap) TE.resetRoadHeatmap();
    TE.ui.setSaveStatus('saved', 'heatmap reset');
    hideSettings();
  }

  function onReturnAllAntsToNest() {
    if (TE.returnAllAntsToNest) TE.returnAllAntsToNest();
    TE.ui.setSaveStatus('saved', 'all ants returning');
    hideSettings();
  }

  function onDeleteAllResources() {
    if (TE.deleteAllResources) TE.deleteAllResources();
    TE.ui.setSaveStatus('saved', 'all resources deleted');
    hideSettings();
  }

  function onUpgradeGather() {
    const s = TE.state;
    if (!s) return;
    const level = (s.nest.gatherLevel || 0);
    const base = 5; // base sugar cost
    const cost = Math.max(1, Math.floor(base * Math.pow(2, level)));
    if ((s.nest.sugar || 0) < cost) {
      TE.ui.setSaveStatus('error', `Need ${cost} sugar`);
      return;
    }
    s.nest.sugar -= cost;
    s.nest.gatherLevel = level + 1;
    s.nest.gatherRadius = (s.nest.gatherRadius || 800) + 200; // increase radius by 200 each level
    TE.markDirty();
    TE.ui.setSaveStatus('saved', `Gather radius upgraded to ${s.nest.gatherRadius}`);
    hideSettings();
  }

  function ensureUpgrades(s) {
    if (!s.nest) s.nest = {};
    if (!s.nest.upgrades) s.nest.upgrades = {};
  }

  function onUpgradeNodeSpawn() {
    const s = TE.state; if (!s) return;
    ensureUpgrades(s);
    const level = s.nest.upgrades.nodeSpawnLevel || 0;
    const cost = Math.max(1, Math.floor(3 * Math.pow(2, level)));
    if ((s.nest.sugar || 0) < cost) { TE.ui.setSaveStatus('error', `Need ${cost} sugar`); return; }
    s.nest.sugar -= cost;
    s.nest.upgrades.nodeSpawnLevel = level + 1;
    s.nest.upgrades.nodeSpawnMul = (s.nest.upgrades.nodeSpawnMul || 1) * 1.2; // 20% more nodes
    TE.markDirty(); TE.ui.setSaveStatus('saved', `Node spawn increased`);
    hideStore();
  }

  function onUpgradeSugarSpawn() {
    const s = TE.state; if (!s) return;
    ensureUpgrades(s);
    const level = s.nest.upgrades.sugarSpawnLevel || 0;
    const cost = Math.max(1, Math.floor(2 * Math.pow(2, level)));
    if ((s.nest.sugar || 0) < cost) { TE.ui.setSaveStatus('error', `Need ${cost} sugar`); return; }
    s.nest.sugar -= cost;
    s.nest.upgrades.sugarSpawnLevel = level + 1;
    s.nest.upgrades.sugarSpawnAdd = (s.nest.upgrades.sugarSpawnAdd || 0) + 0.05; // +5% sugar chance
    TE.markDirty(); TE.ui.setSaveStatus('saved', `Sugar spawn chance increased`);
    hideStore();
  }

  function onUpgradeAntGather() {
    const s = TE.state; if (!s) return;
    ensureUpgrades(s);
    const level = s.nest.upgrades.antGatherLevel || 0;
    const cost = Math.max(1, Math.floor(4 * Math.pow(2, level)));
    if ((s.nest.sugar || 0) < cost) { TE.ui.setSaveStatus('error', `Need ${cost} sugar`); return; }
    s.nest.sugar -= cost;
    s.nest.upgrades.antGatherLevel = level + 1;
    s.nest.upgrades.antGatherMul = (s.nest.upgrades.antGatherMul || 0) + 0.5; // +50% carry per level
    TE.markDirty(); TE.ui.setSaveStatus('saved', `Ant gather increased`);
    hideStore();
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
    document.getElementById('menu-return-ants').addEventListener('click', onReturnAllAntsToNest);
    document.getElementById('menu-reset-heatmap').addEventListener('click', onResetHeatmap);
    document.getElementById('menu-delete-resources').addEventListener('click', onDeleteAllResources);
    const openStoreBtn = document.getElementById('menu-open-store');
    if (openStoreBtn) openStoreBtn.addEventListener('click', () => { hideSettings(); showStore(); });
    storeMenuEl = document.getElementById('store-menu');
    if (!storeMenuEl) {
      // create store menu dynamically
      storeMenuEl = document.createElement('div');
        storeMenuEl.id = 'store-panel';
        storeMenuEl.className = '';
        storeMenuEl.setAttribute('aria-hidden', 'true');
        storeMenuEl.innerHTML = `
          <div class="store-header">
            <h3>Store</h3>
            <button id="store-close" type="button" title="Close">✕</button>
          </div>
          <div class="store-tabs">
            <div class="store-tab active" data-tab="radius">Radius</div>
            <div class="store-tab" data-tab="nodes">Nodes</div>
            <div class="store-tab" data-tab="ants">Ants</div>
          </div>
          <div class="store-content">
            <div class="store-pane" data-pane="radius">
              <div class="store-item"><div>Upgrade Gathering Radius</div><button id="store-upgrade-gather" type="button">Buy</button></div>
            </div>
            <div class="store-pane hidden" data-pane="nodes">
              <div class="store-item"><div>Increase food node spawn rate</div><button id="store-upgrade-node-spawn" type="button">Buy</button></div>
              <div class="store-item"><div>Increase sugar spawn rate</div><button id="store-upgrade-sugar-spawn" type="button">Buy</button></div>
            </div>
            <div class="store-pane hidden" data-pane="ants">
              <div class="store-item"><div>Increase ant gather amount</div><button id="store-upgrade-ant-gather" type="button">Buy</button></div>
            </div>
          </div>
        `;
        document.body.appendChild(storeMenuEl);
        // Wire tab switching
        storeMenuEl.querySelectorAll('.store-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            storeMenuEl.querySelectorAll('.store-tab').forEach(t=>t.classList.remove('active'));
            tab.classList.add('active');
            const which = tab.dataset.tab;
            storeMenuEl.querySelectorAll('.store-pane').forEach(p => {
              if (p.dataset.pane === which) p.classList.remove('hidden'); else p.classList.add('hidden');
            });
          });
        });
        // Close button (handled by wiring below)
    }
    // Wire store UI controls
    const storeClose = document.getElementById('store-close');
    if (storeClose) storeClose.addEventListener('click', () => { hideStore(); });
    const storeUpgrade = document.getElementById('store-upgrade-gather');
    if (storeUpgrade) storeUpgrade.addEventListener('click', () => { onUpgradeGather(); });
    const nodeSpawnBtn = document.getElementById('store-upgrade-node-spawn');
    if (nodeSpawnBtn) nodeSpawnBtn.addEventListener('click', () => { onUpgradeNodeSpawn(); });
    const sugarSpawnBtn = document.getElementById('store-upgrade-sugar-spawn');
    if (sugarSpawnBtn) sugarSpawnBtn.addEventListener('click', () => { onUpgradeSugarSpawn(); });
    const antGatherBtn = document.getElementById('store-upgrade-ant-gather');
    if (antGatherBtn) antGatherBtn.addEventListener('click', () => { onUpgradeAntGather(); });
    const storeHudBtn = document.getElementById('store-btn');
    if (storeHudBtn) storeHudBtn.addEventListener('click', () => { if (storeMenuEl && storeMenuEl.classList.contains('open')) hideStore(); else showStore(); });
    document.getElementById('menu-logout').addEventListener('click', onLogout);
    if (settingsBackdropEl) {
      settingsBackdropEl.addEventListener('click', () => { hideSettings(); hideStore(); });
    }

    // Auto-resume if token exists
    if (TE.net.getToken()) {
      tryResume();
    } else {
      showAuth();
    }
  });
})();
