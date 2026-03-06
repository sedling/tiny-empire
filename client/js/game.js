/**
 * tiny-empire/client/js/game.js
 *
 * Core ant-colony simulation systems.
 * Called once per fixed timestep tick (20 Hz).
 * All randomness via state.rng — never Math.random() or Date.now().
 *
 * Systems: resource spawning, ant spawning, foraging AI, nest economy.
 */
(function () {
  'use strict';
  const TE = window.TinyEmpire = window.TinyEmpire || {}; // Shared TinyEmpire namespace for modules.

  /* ── tuning constants ──────────────────────────────────── */
  const WORLD_RADIUS       = 2000;   // Half-size of world bounds in world units.
  const NEST_GATHERING_RADIUS = 800; // Radius around nest where ants can harvest resources; upgradeable later.
  const MAX_RESOURCES      = 200;    // Legacy upper bound for resource tuning calculations.
  const RESOURCE_SPAWN_CHANCE = 0.002;  // Chance each tick to spawn a new resource node.
  const RESOURCE_NODE_BIAS = 0.7; // 0.0 -> many small nodes, 1.0 -> fewer larger nodes.
  const RESOURCE_NODE_CAP = Math.max(10, Math.floor(MAX_RESOURCES * (1 - (0.55 * RESOURCE_NODE_BIAS)))); // Active node cap after applying bias.
  const RESOURCE_SIZE_SCALE = 1 + (5 * RESOURCE_NODE_BIAS); // Multiplier for per-node resource amounts.
  const RESOURCE_AMOUNT_MIN = Math.max(1, Math.floor(3 * RESOURCE_SIZE_SCALE)); // Minimum spawned amount per resource node.
  const RESOURCE_AMOUNT_MAX_EXCLUSIVE = Math.max(RESOURCE_AMOUNT_MIN + 1, Math.floor(12 * RESOURCE_SIZE_SCALE) + 1); // Exclusive max amount for rng.int.
  const ANT_SPEED          = 1;      // Base ant movement speed before road speed bonuses.
  const ANT_CARRY_AMOUNT   = 1;      // Amount of resource an ant takes per harvest action.
  const ANT_SPEED_VARIANCE = 0.05;   // Per-ant speed multiplier variation (+/- 5%).
  const ANT_IDLE_RETURN_TICKS = 2 * 20; // Idle ants outside nest return home after 2 seconds.
  const RESOURCE_MIN_RETENTION_PCT = 0.075; // Resources inside gathering radius stay at 7.5% (5-10% range midpoint) of spawned amount.
  const ANT_NEST_WAIT_MIN_TICKS = 5 * 20; // Min cooldown (5s at 20 ticks/s) after deposit.
  const ANT_NEST_WAIT_MAX_TICKS = 8 * 20; // Max cooldown (8s at 20 ticks/s) after deposit.
  const FOOD_PER_ANT_SPAWN = 10;     // Nest food cost to spawn one ant.
  const SPAWN_INTERVAL     = 200;    // Ticks between automatic ant spawn attempts.
  const MAX_ANTS           = 5000;   // Hard population cap for performance stability.
  const REPLAN_BUDGET_PER_TICK = 50; // Max ants processed by replan queue each tick.
  const CLAIM_PENALTY = 120;         // Score penalty per existing claim when picking resources.
  const NEST_DISTANCE_WEIGHT = 0.6;  // Weight for nest proximity in resource scoring.
  const RESOURCE_CLAIM_OVERASSIGN = 1.1; // Allow 110% of required gatherers assigned to a node.
  const RESOURCE_GRID_CELL_SIZE = 64; // Cell size for resource spatial index (step 4).
  const RESOURCE_GRID_MAX_RING = 4;   // Max search rings around ant cell during indexed lookup.
  const RESOURCE_GRID_KEY_OFFSET = 32768; // Offset to pack signed cell coords into integer keys.
  const SPAWN_REDIRECT_RADIUS = 180; // Radius to consider rerouting ants to newly spawned nodes.
  const SPAWN_REDIRECT_RADIUS_SQ = SPAWN_REDIRECT_RADIUS * SPAWN_REDIRECT_RADIUS; // Squared redirect radius to avoid sqrt.
  const SPAWN_REDIRECT_ATTENTION_RATE = 0.3; // Share of nearby ants that react to a new spawned node.
  const CLEAR_CLOSER_MARGIN = 30; // New node must be this much clearly closer to reroute.
  const CLEAR_CLOSER_MARGIN_SQ = CLEAR_CLOSER_MARGIN * CLEAR_CLOSER_MARGIN; // Squared closeness margin.
  const NEST_CACHE_RADIUS_SQ = 4; // Radius threshold (2 units) treated as already at nest.
  const NEST_GATHERING_RADIUS_SQ = NEST_GATHERING_RADIUS * NEST_GATHERING_RADIUS;
  const RESERVED_NODES_PCT = 0.015; // Fraction of MAX_RESOURCES reserved to spawn only inside gathering radius (1.5%)
  const NEST_MAX_EXITS_PER_TICK = 2; // Max ants allowed to leave the nest per tick

  /* ── emergent roads (step: traffic trails) ───────────── */
  const ROAD_CELL_SIZE = 10; // Cell size used by road heatmap grid.
  const ROAD_KEY_OFFSET = 32768; // Offset to pack road grid coords into integer keys.
  const ROAD_HEAT_ADD_BASE = 0.004; // Base heat deposited per ant movement sample.
  const ROAD_HEAT_ANT_REF = 600; // Population reference for scaling heat add down at high ant counts.
  const ROAD_HEAT_MAX = 15; // Maximum heat value for a single road cell.
  const ROAD_DECAY_PER_TICK = 0.01; // Heat removed from a decayed cell each tick.
  const ROAD_DECAY_BUDGET = 256; // Max road cells decayed per tick to bound CPU cost.
  const ROAD_STEER_INFLUENCE_BASE = 0.38; // Baseline blend weight toward road direction.
  const ROAD_STEER_MAX_INFLUENCE = 0.78; // Upper cap for road steering influence.
  const ROAD_STEER_HEAT_GAIN = 0.2; // Additional steering influence gained from nearby heat.
  const ROAD_STEER_SAMPLE_DIST = 18; // Forward sample distance when reading road heat.
  const ROAD_STEER_LATERAL = 0.6; // Lateral sample offset factor for left/right probes.
  const ROAD_STEER_FORWARD_BONUS = 0.02; // Small bias to keep movement progressing toward target.
  const ROAD_STEER_NOISE_BASE = 0.035; // Base random lane jitter amount.
  const ROAD_STEER_NOISE_HEAT_GAIN = 0.06; // Extra jitter gained in high-heat lanes.
  const ROAD_STEER_NOISE_MAX = 0.11; // Upper cap for lane jitter.
  const ROAD_SPEED_BONUS_MAX = 0.5; // Maximum road speed increase multiplier (0.5 = +50%).
  const ROAD_SPEED_HEAT_SCALE = 0.7; // Heat-to-speed conversion scale before cap.

  const ROAD_CONFIG = TE.roadConfig || { // Runtime toggles for roads visualization and steering.
    visualEnabled: localStorage.getItem('te_roads_visual') !== '0',
    steeringEnabled: localStorage.getItem('te_roads_steering') !== '0',
  };
  TE.roadConfig = ROAD_CONFIG;
  TE.setRoadVisualEnabled = function setRoadVisualEnabled(enabled) {
    ROAD_CONFIG.visualEnabled = !!enabled;
    localStorage.setItem('te_roads_visual', enabled ? '1' : '0');
  };
  TE.setRoadSteeringEnabled = function setRoadSteeringEnabled(enabled) {
    ROAD_CONFIG.steeringEnabled = !!enabled;
    localStorage.setItem('te_roads_steering', enabled ? '1' : '0');
  };

  /* ── ant FSM states ────────────────────────────────────── */
  const ANT_IDLE        = 'idle';       // Waiting for or requesting a target resource outside nest.
  const ANT_NEST_IDLE   = 'nestIdle';   // Waiting for assignment while cached inside nest (invisible).
  const ANT_TO_RESOURCE = 'toResource'; // Traveling toward selected resource.
  const ANT_HARVEST     = 'harvest';    // Collecting resource at destination cell.
  const ANT_TO_NEST     = 'toNest';     // Returning to nest with carried resource.
  const ANT_DEPOSIT     = 'deposit';    // Depositing carried resource into nest storage.

  /* ── replan queue (step 2) ───────────────────────────── */
  const replanQueue = []; // FIFO queue of ants needing target replanning.
  let replanHead = 0;
  let nestExitsThisTick = 0;

  /* ── resource grid (step 4) ──────────────────────────── */
  const resourceGrid = new Map(); // Sparse spatial index for resources keyed by grid cell.
  let resourceGridSyncedLength = -1;

  /* ── helpers (use RNG, never Math.random) ──────────────── */

  function dist(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function distSq(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    return dx * dx + dy * dy;
  }

  function moveToward(state, obj, tx, ty, speed) {
    const d = dist(obj.x, obj.y, tx, ty);
    if (d < speed) { obj.x = tx; obj.y = ty; return true; }
    let dirX = (tx - obj.x) / d;
    let dirY = (ty - obj.y) / d;

    if (ROAD_CONFIG.steeringEnabled) {
      const rng = state && state.rng;
      const perpX = -dirY;
      const perpY = dirX;
      const hForward = roadHeatAt(state, obj.x + dirX * ROAD_STEER_SAMPLE_DIST, obj.y + dirY * ROAD_STEER_SAMPLE_DIST) + ROAD_STEER_FORWARD_BONUS;

      let leftX = dirX + perpX * ROAD_STEER_LATERAL;
      let leftY = dirY + perpY * ROAD_STEER_LATERAL;
      let leftN = Math.sqrt(leftX * leftX + leftY * leftY);
      let hLeft = 0;
      if (leftN > 0) {
        leftX /= leftN;
        leftY /= leftN;
        hLeft = roadHeatAt(state, obj.x + leftX * ROAD_STEER_SAMPLE_DIST, obj.y + leftY * ROAD_STEER_SAMPLE_DIST);
      }

      let rightX = dirX - perpX * ROAD_STEER_LATERAL;
      let rightY = dirY - perpY * ROAD_STEER_LATERAL;
      let rightN = Math.sqrt(rightX * rightX + rightY * rightY);
      let hRight = 0;
      if (rightN > 0) {
        rightX /= rightN;
        rightY /= rightN;
        hRight = roadHeatAt(state, obj.x + rightX * ROAD_STEER_SAMPLE_DIST, obj.y + rightY * ROAD_STEER_SAMPLE_DIST);
      }

      const totalHeat = hForward + hLeft + hRight;
      if (totalHeat > 0.0001) {
        const roadX = (dirX * hForward + leftX * hLeft + rightX * hRight) / totalHeat;
        const roadY = (dirY * hForward + leftY * hLeft + rightY * hRight) / totalHeat;
        let influence = ROAD_STEER_INFLUENCE_BASE + (totalHeat * ROAD_STEER_HEAT_GAIN);
        if (influence > ROAD_STEER_MAX_INFLUENCE) influence = ROAD_STEER_MAX_INFLUENCE;
        dirX = dirX * (1 - influence) + roadX * influence;
        dirY = dirY * (1 - influence) + roadY * influence;

        // Keep flow organic: slight lane jitter so ants follow trails without perfectly stacking.
        if (rng) {
          let noise = ROAD_STEER_NOISE_BASE + (totalHeat * ROAD_STEER_NOISE_HEAT_GAIN);
          if (noise > ROAD_STEER_NOISE_MAX) noise = ROAD_STEER_NOISE_MAX;
          const jitter = (rng.next() * 2 - 1) * noise;
          const jPerpX = -dirY;
          const jPerpY = dirX;
          dirX += jPerpX * jitter;
          dirY += jPerpY * jitter;
        }
      }

      const n = Math.sqrt(dirX * dirX + dirY * dirY);
      if (n > 0) {
        dirX /= n;
        dirY /= n;
      }
    }

    let moveSpeed = speed;
    if (ROAD_CONFIG.steeringEnabled) {
      const localHeat = roadHeatAt(state, obj.x, obj.y);
      let speedBoost = localHeat * ROAD_SPEED_HEAT_SCALE;
      if (speedBoost > ROAD_SPEED_BONUS_MAX) speedBoost = ROAD_SPEED_BONUS_MAX;
      if (speedBoost > 0) moveSpeed = speed * (1 + speedBoost);
    }

    obj.x += dirX * moveSpeed;
    obj.y += dirY * moveSpeed;
    return false;
  }

  function gridCellCoord(v) {
    return Math.floor(v / RESOURCE_GRID_CELL_SIZE);
  }

  function gridKey(cx, cy) {
    return ((cx + RESOURCE_GRID_KEY_OFFSET) << 16) | ((cy + RESOURCE_GRID_KEY_OFFSET) & 0xFFFF);
  }

  function gridAddResource(resource) {
    const key = gridKey(gridCellCoord(resource.x), gridCellCoord(resource.y));
    let bucket = resourceGrid.get(key);
    if (!bucket) {
      bucket = [];
      resourceGrid.set(key, bucket);
    }
    bucket.push(resource);
  }

  function gridRemoveResource(resource) {
    const key = gridKey(gridCellCoord(resource.x), gridCellCoord(resource.y));
    const bucket = resourceGrid.get(key);
    if (!bucket) return;
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i] === resource) {
        const lastIdx = bucket.length - 1;
        if (i !== lastIdx) bucket[i] = bucket[lastIdx];
        bucket.pop();
        if (bucket.length === 0) resourceGrid.delete(key);
        return;
      }
    }
  }

  function rebuildResourceGrid(resources) {
    resourceGrid.clear();
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      if (!r || r.amount <= 0) continue;
      gridAddResource(r);
    }
    resourceGridSyncedLength = resources.length;
  }

  function ensureResourceGridSynced(state) {
    if (resourceGridSyncedLength !== state.resources.length) {
      rebuildResourceGrid(state.resources);
    }
  }

  function roadCellCoord(v) {
    return Math.floor(v / ROAD_CELL_SIZE);
  }

  function roadKey(cx, cy) {
    return ((cx + ROAD_KEY_OFFSET) << 16) | ((cy + ROAD_KEY_OFFSET) & 0xFFFF);
  }

  function ensureRoadTraffic(state) {
    const rt = state.roadTraffic;
    if (rt && rt.heatByKey && rt.activeCells) {
      rt.cellSize = ROAD_CELL_SIZE;
      return rt;
    }
    state.roadTraffic = {
      cellSize: ROAD_CELL_SIZE,
      heatByKey: new Map(),
      activeCells: [],
      decayCursor: 0,
    };
    return state.roadTraffic;
  }

  function roadHeatAt(state, x, y) {
    const rt = state.roadTraffic;
    if (!rt || !rt.heatByKey) return 0;
    const key = roadKey(roadCellCoord(x), roadCellCoord(y));
    const cell = rt.heatByKey.get(key);
    return cell ? cell.heat : 0;
  }

  function addRoadHeat(state, x, y, amount) {
    if (!(ROAD_CONFIG.visualEnabled || ROAD_CONFIG.steeringEnabled)) return;
    const rt = ensureRoadTraffic(state);
    const cx = roadCellCoord(x);
    const cy = roadCellCoord(y);
    const key = roadKey(cx, cy);
    let cell = rt.heatByKey.get(key);
    if (!cell) {
      cell = { key, cx, cy, heat: 0, index: rt.activeCells.length };
      rt.heatByKey.set(key, cell);
      rt.activeCells.push(cell);
    }
    const nextHeat = cell.heat + amount;
    cell.heat = nextHeat < ROAD_HEAT_MAX ? nextHeat : ROAD_HEAT_MAX;
  }

  function roadHeatAddForPopulation(state) {
    const ants = state.ants.length;
    if (ants <= ROAD_HEAT_ANT_REF) return ROAD_HEAT_ADD_BASE;
    return ROAD_HEAT_ADD_BASE * (ROAD_HEAT_ANT_REF / ants);
  }

  function decayRoadHeat(state) {
    const rt = state.roadTraffic;
    if (!rt || !rt.activeCells || rt.activeCells.length === 0) return;
    let idx = rt.decayCursor;
    let budget = ROAD_DECAY_BUDGET;
    while (budget > 0 && rt.activeCells.length > 0) {
      if (idx >= rt.activeCells.length) idx = 0;
      const cell = rt.activeCells[idx];
      cell.heat -= ROAD_DECAY_PER_TICK;
      if (cell.heat <= 0) {
        rt.heatByKey.delete(cell.key);
        const lastIdx = rt.activeCells.length - 1;
        if (idx !== lastIdx) {
          const moved = rt.activeCells[lastIdx];
          rt.activeCells[idx] = moved;
          moved.index = idx;
        }
        rt.activeCells.pop();
      } else {
        idx++;
      }
      budget--;
    }
    rt.decayCursor = idx;
  }

  function removeResourceById(state, resourceId) {
    const resources = state.resources;
    let idx = -1;
    for (let i = 0; i < resources.length; i++) {
      if (resources[i].id === resourceId) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      state.resourceById.delete(resourceId);
      return false;
    }
    const lastIdx = resources.length - 1;
    const removed = resources[idx];
    if (removed) gridRemoveResource(removed);
    if (idx !== lastIdx) resources[idx] = resources[lastIdx];
    resources.pop();
    state.resourceById.delete(resourceId);
    resourceGridSyncedLength = resources.length;
    return true;
  }

  function countResourcesInNestZone(state) {
    let n = 0;
    for (let i = 0; i < state.resources.length; i++) {
      const r = state.resources[i];
      if (r && resourceInNestGatheringZone(state, r)) n++;
    }
    return n;
  }

  function spawnResourceNearNest(state, rng) {
    if (!state || !rng) return null;
    if (state.resources.length >= RESOURCE_NODE_CAP) return null;
    const angle = rng.range(0, Math.PI * 2);
    const radius = rng.range(0, NEST_GATHERING_RADIUS);
    const x = state.nest.x + Math.cos(angle) * radius;
    const y = state.nest.y + Math.sin(angle) * radius;
    const resource = {
      id:     state.nextResId++,
      x:      x,
      y:      y,
      amount: rng.int(RESOURCE_AMOUNT_MIN, RESOURCE_AMOUNT_MAX_EXCLUSIVE),
      type:   'food',
      claimCount: 0,
      claimCap: 0,
    };
    resource.minAmount = Math.ceil(resource.amount * RESOURCE_MIN_RETENTION_PCT);
    claimCapForResource(resource);
    state.resources.push(resource);
    state.resourceById.set(resource.id, resource);
    gridAddResource(resource);
    resourceGridSyncedLength = state.resources.length;
    retargetNearbyAntsOnSpawn(state, resource, rng);
    TE.markDirty();
    return resource;
  }

  function clearTargetClaim(state, ant) {
    if (!ant || ant.targetResourceId <= 0) return;
    const oldTarget = state.resourceById.get(ant.targetResourceId);
    if (oldTarget && oldTarget.claimCount > 0) oldTarget.claimCount--;
    ant.targetResourceId = 0;
  }

  function resourceInNestGatheringZone(state, resource) {
    const nestDistSq = distSq(state.nest.x, state.nest.y, resource.x, resource.y);
    return nestDistSq <= NEST_GATHERING_RADIUS_SQ;
  }

  function claimCapForResource(resource) {
    if (!resource || resource.amount <= 0) return 0;
    // Recompute cap each time from current amount to avoid stale cached caps
    const neededGatherers = Math.max(1, Math.ceil(resource.amount / ANT_CARRY_AMOUNT));
    const cap = Math.max(1, Math.ceil(neededGatherers * RESOURCE_CLAIM_OVERASSIGN));
    resource.claimCap = cap;
    return cap;
  }

  function resourceHasCapacity(resource) {
    if (!resource || resource.amount <= 0) return false;
    const cap = claimCapForResource(resource);
    return (resource.claimCount || 0) < cap;
  }

  function resourceHasHarvestableAmount(state, resource) {
    if (!resource || resource.amount <= 0) return false;
    const isInZone = resourceInNestGatheringZone(state, resource);
    const minAmount = isInZone ? (resource.minAmount || 0) : 0;
    return resource.amount > minAmount;  // Must have harvestable amount above minimum
  }

  function setTargetResource(state, ant, target) {
    const dbg = state && state.debug;
    if (!ant || !target) {
      if (dbg) dbg.assignFailuresAmountZero = (dbg.assignFailuresAmountZero || 0) + 1;
      return false;
    }
    if (target.amount <= 0) {
      if (dbg) dbg.assignFailuresAmountZero = (dbg.assignFailuresAmountZero || 0) + 1;
      return false;
    }
    if (ant.targetResourceId === target.id) {
      ant.state = ANT_TO_RESOURCE;
      ant.idleSinceTick = 0;
      ant.needsReplan = false;
      ant.inReplanQueue = false;
      return true;
    }
    if (!resourceHasCapacity(target)) {
      if (dbg) dbg.assignFailuresCapacity = (dbg.assignFailuresCapacity || 0) + 1;
      return false;
    }
    if (!resourceHasHarvestableAmount(state, target)) {
      if (dbg) dbg.assignFailuresNoHarvest = (dbg.assignFailuresNoHarvest || 0) + 1;
      return false;
    }
    clearTargetClaim(state, ant);
    ant.targetResourceId = target.id;
    target.claimCount = (target.claimCount || 0) + 1;
    ant.idleSinceTick = 0;
    ant.needsReplan = false;
    ant.inReplanQueue = false;
    // If ant is currently cached in the nest, only allow a limited number to exit per tick.
    if (ant.inNest) {
      if (nestExitsThisTick < NEST_MAX_EXITS_PER_TICK) {
        ant.inNest = false;
        ant.state = ANT_TO_RESOURCE;
        nestExitsThisTick++;
      } else {
        // Mark pending exit; stay in nest until allowed to leave in ANT_NEST_IDLE handling
        ant.pendingExit = true;
        // Keep state as ANT_NEST_IDLE so the ant remains invisible/cached
        ant.state = ANT_NEST_IDLE;
      }
    } else {
      ant.state = ANT_TO_RESOURCE;
    }
    return true;
  }

  function randomNestWaitTicks(rng) {
    return rng.int(ANT_NEST_WAIT_MIN_TICKS, ANT_NEST_WAIT_MAX_TICKS + 1);
  }

  function randomSpeedMultiplier(rng) {
    return 1 + rng.range(-ANT_SPEED_VARIANCE, ANT_SPEED_VARIANCE);
  }

  function resetRoadHeatmap() {
    const s = TE.state;
    if (!s) return;
    s.roadTraffic = {
      cellSize: ROAD_CELL_SIZE,
      heatByKey: new Map(),
      activeCells: [],
      decayCursor: 0,
    };
    TE.markDirty();
  }

  function returnAllAntsToNest() {
    const s = TE.state;
    if (!s || !Array.isArray(s.ants)) return;
    for (let i = 0; i < s.ants.length; i++) {
      const ant = s.ants[i];
      clearTargetClaim(s, ant);
      ant.state = ANT_TO_NEST;
      ant.needsReplan = false;
      ant.inReplanQueue = false;
      ant.departAtTick = 0;
      ant.inNest = false;
      ant.idleSinceTick = 0;
    }
    replanQueue.length = 0;
    replanHead = 0;
    TE.markDirty();
  }

  function deleteAllResources() {
    const s = TE.state;
    if (!s || !Array.isArray(s.resources)) return;
    s.resources.length = 0;
    s.resourceById.clear();
    resourceGridSyncedLength = -1;
    rebuildResourceGrid(s.resources);
    TE.markDirty();
  }

  function chooseBestResourceForAnt(state, ant) {
    ensureResourceGridSynced(state);

    function scoreResource(r) {
      if (!resourceInNestGatheringZone(state, r)) return Number.POSITIVE_INFINITY;
      const antDistance = dist(ant.x, ant.y, r.x, r.y);
      const nestDistance = dist(state.nest.x, state.nest.y, r.x, r.y);
      const claims = r.claimCount || 0;
      return antDistance + (nestDistance * NEST_DISTANCE_WEIGHT) + (CLAIM_PENALTY * claims);
    }

    function considerBucket(bucket, best) {
      if (!bucket) return best;
      for (let i = 0; i < bucket.length; i++) {
        const r = bucket[i];
        if (!resourceInNestGatheringZone(state, r)) continue;
        if (!resourceHasCapacity(r)) continue;
        if (!resourceHasHarvestableAmount(state, r)) continue;
        const score = scoreResource(r);
        if (score < best.score) {
          best.score = score;
          best.resource = r;
        }
      }
      return best;
    }

    const antCx = gridCellCoord(ant.x);
    const antCy = gridCellCoord(ant.y);
    const best = { resource: null, score: Number.POSITIVE_INFINITY };

    for (let ring = 0; ring <= RESOURCE_GRID_MAX_RING; ring++) {
      if (ring === 0) {
        considerBucket(resourceGrid.get(gridKey(antCx, antCy)), best);
      } else {
        const minX = antCx - ring;
        const maxX = antCx + ring;
        const minY = antCy - ring;
        const maxY = antCy + ring;

        for (let cx = minX; cx <= maxX; cx++) {
          considerBucket(resourceGrid.get(gridKey(cx, minY)), best);
          considerBucket(resourceGrid.get(gridKey(cx, maxY)), best);
        }
        for (let cy = minY + 1; cy <= maxY - 1; cy++) {
          considerBucket(resourceGrid.get(gridKey(minX, cy)), best);
          considerBucket(resourceGrid.get(gridKey(maxX, cy)), best);
        }
      }

      if (best.resource) return best.resource;
    }

    // Sparse-world fallback when nearby cells are empty.
    const resources = state.resources;
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      if (!resourceInNestGatheringZone(state, r)) continue;
      if (!resourceHasCapacity(r)) continue;
      if (!resourceHasHarvestableAmount(state, r)) continue;
      const score = scoreResource(r);
      if (score < best.score) {
        best.score = score;
        best.resource = r;
      }
    }
    return best.resource;
  }

  function enqueueForReplan(ant) {
    ant.needsReplan = true;
    if (ant.inReplanQueue) return;
    ant.inReplanQueue = true;
    replanQueue.push(ant);
  }

  function processReplanQueue(state, rng, debug) {
    const resources = state.resources;
    const initialTail = replanQueue.length;
    let processed = 0;

    // Priority pass: process a small batch of nested ants that are ready to depart
    if (replanHead < initialTail) {
      const priorityLimit = Math.min(REPLAN_BUDGET_PER_TICK, 200);
      let priorityCount = 0;
      for (let i = replanHead; i < initialTail && priorityCount < priorityLimit; i++) {
        const ant = replanQueue[i];
        if (!ant) continue;
        // eligible if in nest and depart cooldown expired (or no cooldown)
        if (ant.inNest && (!ant.departAtTick || state.gameTick >= ant.departAtTick) && ant.needsReplan && ant.carrying === 0) {
          // remove from queue slot to avoid double-processing; mark as not queued
          replanQueue[i] = null;
          ant.inReplanQueue = false;
          priorityCount++;
          // process this ant immediately
          if (resources.length > 0) {
            const target = chooseBestResourceForAnt(state, ant);
            if (target) {
              if (debug) debug.assignAttempts = (debug.assignAttempts || 0) + 1;
              const ok = setTargetResource(state, ant, target);
              if (ok) {
                if (debug) debug.assignSuccesses = (debug.assignSuccesses || 0) + 1;
              } else {
                if (debug) {
                  if (!resourceHasCapacity(target)) debug.assignFailuresCapacity = (debug.assignFailuresCapacity || 0) + 1;
                  else if (!resourceHasHarvestableAmount(state, target)) debug.assignFailuresNoHarvest = (debug.assignFailuresNoHarvest || 0) + 1;
                  else debug.assignFailuresAmountZero = (debug.assignFailuresAmountZero || 0) + 1;
                }
                enqueueForReplan(ant);
              }
            } else {
              enqueueForReplan(ant);
            }
          } else {
            enqueueForReplan(ant);
          }
          processed++;
        }
      }
      // compact nulls from the queue if we cleared many entries
      if (priorityCount > 0 && replanHead === 0) {
        // remove leading nulls
        while (replanQueue.length > 0 && replanQueue[0] === null) replanQueue.shift();
        // adjust initialTail accordingly
      }
    }

    while (processed < REPLAN_BUDGET_PER_TICK && replanHead < initialTail) {
      const ant = replanQueue[replanHead++];
      if (!ant) continue;
      ant.inReplanQueue = false;

      if (debug) debug.replansProcessed = (debug.replansProcessed || 0) + 1;

      if (!ant.needsReplan) {
        processed++;
        continue;
      }

      if (ant.inNest) {
        if (ant.departAtTick && state.gameTick < ant.departAtTick) {
          processed++;
          continue;  // Still in cooldown, wait
        }
        ant.departAtTick = 0;  // Cooldown expired, but stay nested until task is assigned
      }

      if (ant.carrying > 0) {
        ant.needsReplan = false;
        ant.state = ANT_TO_NEST;
        ant.idleSinceTick = 0;
        processed++;
        continue;
      }

      if (resources.length > 0) {
        const target = chooseBestResourceForAnt(state, ant);
        if (target) {
          if (debug) debug.assignAttempts = (debug.assignAttempts || 0) + 1;
          const ok = setTargetResource(state, ant, target);
          if (ok) {
            if (debug) debug.assignSuccesses = (debug.assignSuccesses || 0) + 1;
          } else {
            if (debug) {
              if (!resourceHasCapacity(target)) debug.assignFailuresCapacity = (debug.assignFailuresCapacity || 0) + 1;
              else if (!resourceHasHarvestableAmount(state, target)) debug.assignFailuresNoHarvest = (debug.assignFailuresNoHarvest || 0) + 1;
              else debug.assignFailuresAmountZero = (debug.assignFailuresAmountZero || 0) + 1;
            }
            enqueueForReplan(ant);
          }
        } else {
          enqueueForReplan(ant);
        }
      } else {
        enqueueForReplan(ant);
      }

      processed++;
    }

    if (replanHead >= replanQueue.length) {
      replanQueue.length = 0;
      replanHead = 0;
    } else if (replanHead > 1024 && replanHead * 2 > replanQueue.length) {
      replanQueue.splice(0, replanHead);
      replanHead = 0;
    }

    debug.antsNeedingReplan = replanQueue.length - replanHead;
  }

  function retargetNearbyAntsOnSpawn(state, resource, rng) {
    const ants = state.ants;
    for (let i = 0; i < ants.length; i++) {
      const ant = ants[i];
      if (ant.inNest) {
        const readyToDepart = (!ant.departAtTick || state.gameTick >= ant.departAtTick);
        if (!readyToDepart) continue; // still cached, not eligible
      }
      if (ant.carrying > 0) continue;
      if (ant.state === ANT_TO_NEST || ant.state === ANT_DEPOSIT || ant.state === ANT_HARVEST) continue;

      const newDistSq = distSq(ant.x, ant.y, resource.x, resource.y);
      if (newDistSq > SPAWN_REDIRECT_RADIUS_SQ) continue;
      if (rng.next() > SPAWN_REDIRECT_ATTENTION_RATE) continue;
      if (!resourceHasHarvestableAmount(state, resource)) continue;

      let oldDistSq = Number.POSITIVE_INFINITY;
      if (ant.targetResourceId > 0) {
        const oldTarget = state.resourceById.get(ant.targetResourceId);
        if (oldTarget && oldTarget.amount > 0) {
          oldDistSq = distSq(ant.x, ant.y, oldTarget.x, oldTarget.y);
        }
      }

      if (oldDistSq < Number.POSITIVE_INFINITY && newDistSq + CLEAR_CLOSER_MARGIN_SQ >= oldDistSq) {
        continue;
      }

      setTargetResource(state, ant, resource);
    }
  }

  /* ── tick ───────────────────────────────────────────────── */

  function tick() {
    const s   = TE.state;
    const rng = s.rng;
    if (!rng) return;

    s.gameTick++;

    // reset per-tick nest exit counter
    nestExitsThisTick = 0;

    const debug = s.debug || (s.debug = {
      totalAnts: 0,
      antsNeedingReplan: 0,
      invalidTargetDropsTick: 0,
      invalidTargetDropsTotal: 0,
      replansProcessed: 0,
      assignAttempts: 0,
      assignFailuresCapacity: 0,
      assignFailuresNoHarvest: 0,
      assignFailuresAmountZero: 0,
      assignSuccesses: 0,
    });
    debug.totalAnts = s.ants.length;
    debug.antsNeedingReplan = 0;
    debug.invalidTargetDropsTick = 0;
    if (!Number.isFinite(debug.invalidTargetDropsTotal)) debug.invalidTargetDropsTotal = 0;

    const roadHeatAdd = roadHeatAddForPopulation(s);
    decayRoadHeat(s);

    // 1) Possibly spawn a new resource
    if (s.resources.length < RESOURCE_NODE_CAP && rng.next() < RESOURCE_SPAWN_CHANCE) {
      const insideCount = countResourcesInNestZone(s);
      const reservedCount = Math.max(1, Math.floor(MAX_RESOURCES * RESERVED_NODES_PCT));
      // If we haven't filled the reserved quota for nest-zone nodes yet, spawn near nest.
      if (insideCount < reservedCount) {
        spawnResourceNearNest(s, rng);
      } else {
        const resource = {
          id:     s.nextResId++,
          x:      rng.range(-WORLD_RADIUS, WORLD_RADIUS),
          y:      rng.range(-WORLD_RADIUS, WORLD_RADIUS),
          amount: rng.int(RESOURCE_AMOUNT_MIN, RESOURCE_AMOUNT_MAX_EXCLUSIVE),
          type:   'food',
          claimCount: 0,
          claimCap: 0,
        };
        resource.minAmount = Math.ceil(resource.amount * RESOURCE_MIN_RETENTION_PCT);
        claimCapForResource(resource);
        s.resources.push(resource);
        s.resourceById.set(resource.id, resource);
        gridAddResource(resource);
        resourceGridSyncedLength = s.resources.length;
        retargetNearbyAntsOnSpawn(s, resource, rng);
        TE.markDirty();
      }
    }

    // 2) Ant spawning (nest auto-spawns workers if affordable)
    if (s.gameTick % SPAWN_INTERVAL === 0 && s.nest.food >= FOOD_PER_ANT_SPAWN && s.ants.length < MAX_ANTS) {
      s.nest.food -= FOOD_PER_ANT_SPAWN;
      s.nest.population++;
      s.ants.push({
        id:      s.nextAntId++,
        x:       s.nest.x,
        y:       s.nest.y,
        state:   ANT_NEST_IDLE,
        targetResourceId: 0,
        carrying: 0,
        carryType: null,
        speedMul: randomSpeedMultiplier(rng),
        departAtTick: 0,
        idleSinceTick: 0,
        inNest: true,
        needsReplan: true,
        inReplanQueue: false,
      });
      enqueueForReplan(s.ants[s.ants.length - 1]);
      TE.markDirty();
    }

    processReplanQueue(s, rng, debug);

    // 3) Update each ant
    for (let i = 0; i < s.ants.length; i++) {
      const ant = s.ants[i];

      // If an ant is outside the nest with no target and not carrying, treat it as idle
      if (!ant.inNest && ant.carrying === 0 && ant.targetResourceId === 0 && ant.state !== ANT_TO_NEST && ant.state !== ANT_DEPOSIT && ant.state !== ANT_HARVEST && ant.state !== ANT_TO_RESOURCE) {
        if (ant.state !== ANT_IDLE) {
          ant.state = ANT_IDLE;
          ant.idleSinceTick = s.gameTick;
        }
      }

      if (ant.targetResourceId > 0) {
        const target = s.resourceById.get(ant.targetResourceId);
        if (!target || target.amount <= 0) {
          clearTargetClaim(s, ant);
          if (ant.carrying > 0) {
            ant.state = ANT_TO_NEST;
            ant.needsReplan = false;
          } else {
            ant.state = ANT_NEST_IDLE;
            enqueueForReplan(ant);
            debug.invalidTargetDropsTick++;
            debug.invalidTargetDropsTotal++;
          }
        }
      }

      switch (ant.state) {
        case ANT_IDLE: {
          if (!(ant.idleSinceTick > 0)) ant.idleSinceTick = s.gameTick;
          if (ant.carrying > 0) {
            ant.state = ANT_TO_NEST;
            ant.idleSinceTick = 0;
            ant.inNest = false;
            ant.needsReplan = false;
            break;
          }
          const idleTicks = s.gameTick - ant.idleSinceTick;
          const nestDistSq = distSq(ant.x, ant.y, s.nest.x, s.nest.y);
          if (idleTicks >= ANT_IDLE_RETURN_TICKS && nestDistSq > NEST_CACHE_RADIUS_SQ) {
            clearTargetClaim(s, ant);
            ant.state = ANT_TO_NEST;
            ant.idleSinceTick = 0;
            ant.needsReplan = false;
            ant.inNest = false;
            break;
          }
          if (ant.needsReplan) {
            enqueueForReplan(ant);
          }
          break;
        }
        case ANT_TO_RESOURCE: {
          ant.idleSinceTick = 0;
          ant.inNest = false;
          const target = s.resourceById.get(ant.targetResourceId);
          if (!target || target.amount <= 0) {
            clearTargetClaim(s, ant);
            ant.state = ANT_NEST_IDLE;
            enqueueForReplan(ant);
            break;
          }
          const arrived = moveToward(s, ant, target.x, target.y, ANT_SPEED * (ant.speedMul || 1));
          addRoadHeat(s, ant.x, ant.y, roadHeatAdd);
          if (arrived) {
            ant.state = ANT_HARVEST;
          }
          break;
        }
        case ANT_HARVEST: {
          ant.idleSinceTick = 0;
          ant.inNest = false;
          const target = s.resourceById.get(ant.targetResourceId);
          let changed = false;
          let tookAny = false;
          if (target && target.amount > 0) {
            const isInZone = resourceInNestGatheringZone(s, target);
            const minAmount = isInZone ? (target.minAmount || 0) : 0;
            const maxCanTake = Math.max(0, target.amount - minAmount);
            const actualTaken = Math.min(maxCanTake, ANT_CARRY_AMOUNT);
            tookAny = (actualTaken > 0);
            
            if (tookAny) {
              target.amount -= actualTaken;
              ant.carrying += actualTaken;
              ant.carryType = target.type || 'food';
              changed = true;
              clearTargetClaim(s, ant);
            }
            if (target.amount <= minAmount) {
              removeResourceById(s, target.id);
            }
          } else {
            clearTargetClaim(s, ant);
            enqueueForReplan(ant);
          }
          if (tookAny) {
            ant.needsReplan = false;
            ant.state = ANT_TO_NEST;
          } else {
            ant.state = ANT_NEST_IDLE;
            ant.inNest = true;  // No harvest possible; go back to nest idle
            enqueueForReplan(ant);
          }
          if (changed) TE.markDirty();
          break;
        }
        case ANT_TO_NEST: {
          ant.idleSinceTick = 0;
          ant.inNest = false;
          const home = moveToward(s, ant, s.nest.x, s.nest.y, ANT_SPEED * (ant.speedMul || 1));
          addRoadHeat(s, ant.x, ant.y, roadHeatAdd);
          if (home) {
            ant.state = ANT_DEPOSIT;
          }
          break;
        }
        case ANT_DEPOSIT: {
          ant.idleSinceTick = s.gameTick;
          ant.inNest = true;
          ant.x = s.nest.x;
          ant.y = s.nest.y;
          if (ant.carrying > 0) {
            s.nest.food += ant.carrying;
            TE.markDirty();
          }
          ant.carrying = 0;
          ant.carryType = null;
          clearTargetClaim(s, ant);
          ant.departAtTick = s.gameTick + randomNestWaitTicks(rng);
          ant.needsReplan = true;
          ant.state = ANT_NEST_IDLE;  // Move to nest-idle, not ANT_IDLE
          break;
        }
        case ANT_NEST_IDLE: {
          // Ants stay here, invisible, until processReplanQueue assigns them a task
          if (ant.departAtTick && s.gameTick < ant.departAtTick) {
            break;  // Still in nest cooldown, wait
          }
          ant.departAtTick = 0;

          // If this ant was assigned while still in the nest, allow a limited
          // number to exit each tick. Also allow ants without pendingExit but
          // with a target to exit when budget allows.
          const hasAssignedTarget = ant.targetResourceId && ant.targetResourceId > 0 && ant.carrying === 0;
          if ((ant.pendingExit || hasAssignedTarget) && nestExitsThisTick < NEST_MAX_EXITS_PER_TICK) {
            ant.pendingExit = false;
            ant.inNest = false;
            ant.state = ANT_TO_RESOURCE;
            nestExitsThisTick++;
            break;
          }

          if (ant.needsReplan) {
            enqueueForReplan(ant);  // Will be processed next tick
          }
          break;  // Stay invisible until assigned or allowed to exit
        }
      }
    }

    debug.antsNeedingReplan = replanQueue.length - replanHead;
  }

  TE.gameTick = tick;
  TE.WORLD_RADIUS = WORLD_RADIUS;
  TE.NEST_GATHERING_RADIUS = NEST_GATHERING_RADIUS;
  TE.resetRoadHeatmap = resetRoadHeatmap;
  TE.returnAllAntsToNest = returnAllAntsToNest;
  TE.deleteAllResources = deleteAllResources;
})();
