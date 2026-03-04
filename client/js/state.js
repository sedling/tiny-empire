/**
 * tiny-empire/client/js/state.js
 *
 * Central game state container with dirty tracking.
 * Simulation ticks advance gameTick; rendering reads but never mutates state.
 * The save payload is produced by serialise(); loaded back by deserialise().
 */
(function () {
  'use strict';
  const TE = window.TinyEmpire = window.TinyEmpire || {};

  /** Current save schema version (must match server SAVE_SCHEMA_VERSION). */
  const SAVE_SCHEMA_VERSION = 1;

  const state = {
    /* ── simulation ─────────────────────────────────────── */
    gameTick:   0,
    rngSeed:    0,
    rng:        null,   // TinyEmpire.RNG instance (set by boot)

    /* ── colony ─────────────────────────────────────────── */
    nest: {
      x: 0, y: 0,
      food: 50,
      population: 5,
    },
    ants:      [],  // { id, x, y, state, targetX, targetY, carrying }
    resources: [],  // { id, x, y, amount, type }

    /* ── meta ───────────────────────────────────────────── */
    dirty:     false,   // true when state changed since last save
    nextAntId: 1,
    nextResId: 1,
  };

  /** Mark state as changed (triggers autosave timer). */
  function markDirty() { state.dirty = true; }

  /** Build a serialisable save payload (no functions, no RNG object). */
  function serialise() {
    return {
      saveSchemaVersion: SAVE_SCHEMA_VERSION,
      gameTick:   state.gameTick,
      rngSeed:    state.rngSeed,
      nest:       { x: state.nest.x, y: state.nest.y, food: state.nest.food, population: state.nest.population },
      ants:       state.ants.map(a => ({ id: a.id, x: a.x, y: a.y, state: a.state, targetX: a.targetX, targetY: a.targetY, carrying: a.carrying })),
      resources:  state.resources.map(r => ({ id: r.id, x: r.x, y: r.y, amount: r.amount, type: r.type })),
      nextAntId:  state.nextAntId,
      nextResId:  state.nextResId,
    };
  }

  /** Restore state from a parsed save payload. */
  function deserialise(save) {
    if (!save) return;
    state.gameTick   = save.gameTick   || 0;
    state.rngSeed    = save.rngSeed    || 0;
    state.nest       = save.nest       || { x: 0, y: 0, food: 50, population: 5 };
    state.ants       = save.ants       || [];
    state.resources  = save.resources  || [];
    state.nextAntId  = save.nextAntId  || 1;
    state.nextResId  = save.nextResId  || 1;
    state.dirty      = false;
    // Re-create RNG from the saved seed
    state.rng = new TE.RNG(state.rngSeed);
    // Advance RNG to match gameTick so sequence is deterministic
    // (fast-forward is cheap for mulberry32)
    for (let i = 0; i < state.gameTick; i++) state.rng.next();
  }

  /** Initialise a fresh game with a random seed. */
  function initNew() {
    // Use Date.now() ONLY here for seed generation (not in sim logic)
    state.rngSeed  = (Date.now() ^ 0xDEADBEEF) >>> 0;
    state.gameTick = 0;
    state.rng      = new TE.RNG(state.rngSeed);
    state.nest     = { x: 0, y: 0, food: 50, population: 5 };
    state.ants     = [];
    state.resources = [];
    state.nextAntId = 1;
    state.nextResId = 1;
    state.dirty     = true;
  }

  TE.SAVE_SCHEMA_VERSION = SAVE_SCHEMA_VERSION;
  TE.state       = state;
  TE.markDirty   = markDirty;
  TE.serialise   = serialise;
  TE.deserialise = deserialise;
  TE.initNew     = initNew;
})();
