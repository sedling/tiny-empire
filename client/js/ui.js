/**
 * tiny-empire/client/js/ui.js
 *
 * HUD updates (food, population, tick, save status, connection indicator).
 */
(function () {
  'use strict';
  const TE = window.TinyEmpire = window.TinyEmpire || {};

  let elFood, elPop, elTick, elSave, elConn;

  function init() {
    elFood = document.getElementById('hud-food');
    elPop  = document.getElementById('hud-pop');
    elTick = document.getElementById('hud-tick');
    elSave = document.getElementById('hud-save-status');
    elConn = document.getElementById('hud-connection');
  }

  function update() {
    const s = TE.state;
    if (elFood) elFood.textContent = `Food: ${Math.floor(s.nest.food)}`;
    if (elPop)  {
      const inside = s.ants.reduce((n,a)=>n + (a.inNest ? 1 : 0), 0);
      const outside = Math.max(0, s.ants.length - inside);
      elPop.textContent  = `Ants: ${s.ants.length} (${inside}/${outside})`;
    }
    if (elTick) elTick.textContent = `Tick: ${s.gameTick}`;
  }

  /** Set save-status text in HUD. status: 'saving'|'saved'|'error'|'offline' */
  function setSaveStatus(status, detail) {
    if (!elSave) return;
    const labels = {
      saving:  'Saving…',
      saved:   detail ? `Saved ${detail}` : 'Saved',
      error:   detail ? `Save error: ${detail}` : 'Save error',
      offline: 'Offline',
    };
    elSave.textContent = labels[status] || status;
  }

  /** Set connection indicator. online: boolean. */
  function setConnection(online) {
    if (!elConn) return;
    elConn.textContent = online ? 'online' : 'offline';
    elConn.className   = online ? 'status-online' : 'status-offline';
  }

  TE.ui = { init, update, setSaveStatus, setConnection };
})();
