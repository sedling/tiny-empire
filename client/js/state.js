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

  function createRoadTrafficState() {
    return {
      cellSize: 24,
      heatByKey: new Map(),
      activeCells: [],
      decayCursor: 0,
    };
  }

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
    ants:      [],  // { id, x, y, state, targetResourceId, carrying, carryType, needsReplan }
    resources: [],  // { id, x, y, amount, type, claimCount }
    resourceById: new Map(),
    roadTraffic: createRoadTrafficState(),

    /* ── perf debug ─────────────────────────────────────── */
    debug: {
      totalAnts: 0,
      antsNeedingReplan: 0,
      invalidTargetDropsTick: 0,
      invalidTargetDropsTotal: 0,
    },

    /* ── meta ───────────────────────────────────────────── */
    dirty:     false,   // true when state changed since last save
    nextAntId: 1,
    nextResId: 1,
  };

  /** Mark state as changed (triggers autosave timer). */
  function markDirty() { state.dirty = true; }

  function normalizeAntState(rawState) {
    if (rawState === 'forage') return 'toResource';
    if (rawState === 'return') return 'toNest';
    if (rawState === 'idle' || rawState === 'nestIdle' || rawState === 'toResource' || rawState === 'harvest' || rawState === 'toNest' || rawState === 'deposit') {
      return rawState;
    }
    return 'nestIdle';
  }

  /** Build a serialisable save payload (no functions, no RNG object). */
  function serialise() {
    return {
      saveSchemaVersion: SAVE_SCHEMA_VERSION,
      gameTick:   state.gameTick,
      rngSeed:    state.rngSeed,
      nest:       { x: state.nest.x, y: state.nest.y, food: state.nest.food, population: state.nest.population },
      ants:       state.ants.map((a) => ({
        id: a.id,
        x: a.x,
        y: a.y,
        state: a.state,
        targetResourceId: a.targetResourceId || 0,
        carrying: a.carrying || 0,
        carryType: a.carryType || null,
        speedMul: (typeof a.speedMul === 'number') ? a.speedMul : 1,
        departAtTick: a.departAtTick || 0,
        idleSinceTick: a.idleSinceTick || 0,
        inNest: !!a.inNest,
        needsReplan: !!a.needsReplan,
      })),
      resources:  state.resources.map(r => ({ id: r.id, x: r.x, y: r.y, amount: r.amount, type: r.type, claimCount: r.claimCount || 0, claimCap: r.claimCap || 0, minAmount: r.minAmount || 0 })),
      nextAntId:  state.nextAntId,
      nextResId:  state.nextResId,
      debug: {
        invalidTargetDropsTotal: state.debug.invalidTargetDropsTotal | 0,
      },
      roadTraffic: (() => {
        const rt = state.roadTraffic;
        if (!rt || !rt.activeCells) return { cellSize: 24, cells: [] };
        const cells = [];
        for (let i = 0; i < rt.activeCells.length; i++) {
          const c = rt.activeCells[i];
          if (!c || c.heat <= 0.0001) continue;
          cells.push([c.cx, c.cy, c.heat]);
        }
        return { cellSize: rt.cellSize || 24, cells };
      })(),
    };
  }

  /** Restore state from a parsed save payload. */
  function deserialise(save) {
    if (!save) return;
    state.gameTick   = save.gameTick   || 0;
    state.rngSeed    = save.rngSeed    || 0;
    state.nest       = save.nest       || { x: 0, y: 0, food: 50, population: 5 };
    const savedAnts = save.ants || [];
    const ants = new Array(savedAnts.length);
    for (let i = 0; i < savedAnts.length; i++) {
      const a = savedAnts[i] || {};
      const targetResourceId = Number.isFinite(a.targetResourceId) ? (a.targetResourceId | 0) : 0;
      ants[i] = {
        id: a.id || 0,
        x: a.x || 0,
        y: a.y || 0,
        state: normalizeAntState(a.state),
        targetResourceId: targetResourceId > 0 ? targetResourceId : 0,
        carrying: a.carrying || 0,
        carryType: a.carryType || ((a.carrying || 0) > 0 ? 'food' : null),
        speedMul: (typeof a.speedMul === 'number') ? a.speedMul : 1,
        departAtTick: a.departAtTick || 0,
        idleSinceTick: a.idleSinceTick || 0,
        inNest: !!a.inNest,
        inReplanQueue: false,
        needsReplan: (typeof a.needsReplan === 'boolean') ? a.needsReplan : !(targetResourceId > 0),
      };
    }
    state.ants = ants;

    const savedResources = save.resources || [];
    const resources = [];
    for (let i = 0; i < savedResources.length; i++) {
      const r = savedResources[i];
      if (!r) continue;
      const amount = Number(r.amount) || 0;
      if (amount <= 0) continue;
      resources.push({ id: r.id, x: r.x, y: r.y, amount, type: r.type, claimCount: Number(r.claimCount) || 0, claimCap: Number(r.claimCap) || 0, minAmount: Number(r.minAmount) || 0 });
    }
    state.resources = resources;
    state.resourceById.clear();
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      state.resourceById.set(r.id, r);
      r.claimCount = 0;
    }

    for (let i = 0; i < ants.length; i++) {
      const ant = ants[i];
      if (ant.targetResourceId <= 0) continue;
      const target = state.resourceById.get(ant.targetResourceId);
      if (target && target.amount > 0) {
        target.claimCount = (target.claimCount || 0) + 1;
      }
    }

    for (let i = 0; i < ants.length; i++) {
      const ant = ants[i];
      if (ant.targetResourceId > 0 && !state.resourceById.has(ant.targetResourceId)) {
        ant.targetResourceId = 0;
        ant.state = 'nestIdle';
        ant.needsReplan = true;
      }
    }

    state.nextAntId  = save.nextAntId  || 1;
    state.nextResId  = save.nextResId  || 1;
    state.roadTraffic = createRoadTrafficState();
    if (save.roadTraffic && Array.isArray(save.roadTraffic.cells)) {
      const rt = state.roadTraffic;
      rt.cellSize = Number(save.roadTraffic.cellSize) || rt.cellSize;
      for (let i = 0; i < save.roadTraffic.cells.length; i++) {
        const row = save.roadTraffic.cells[i];
        if (!Array.isArray(row) || row.length < 3) continue;
        const cx = row[0] | 0;
        const cy = row[1] | 0;
        const heat = Number(row[2]) || 0;
        if (heat <= 0.0001) continue;
        const key = ((cx + 32768) << 16) | ((cy + 32768) & 0xFFFF);
        const cell = { key, cx, cy, heat, index: rt.activeCells.length };
        rt.heatByKey.set(key, cell);
        rt.activeCells.push(cell);
      }
    }
    state.debug = {
      totalAnts: 0,
      antsNeedingReplan: 0,
      invalidTargetDropsTick: 0,
      invalidTargetDropsTotal: (save.debug && Number.isFinite(save.debug.invalidTargetDropsTotal))
        ? (save.debug.invalidTargetDropsTotal | 0)
        : 0,
    };
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
    state.resourceById.clear();
    state.roadTraffic = createRoadTrafficState();
    state.debug = {
      totalAnts: 0,
      antsNeedingReplan: 0,
      invalidTargetDropsTick: 0,
      invalidTargetDropsTotal: 0,
    };
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
