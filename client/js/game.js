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
  const TE = window.TinyEmpire = window.TinyEmpire || {};

  /* ── tuning constants ──────────────────────────────────── */
  const WORLD_RADIUS       = 400;   // world extends ±WORLD_RADIUS
  const MAX_RESOURCES      = 2000;
  const RESOURCE_SPAWN_CHANCE = 5;  // per tick
  const ANT_SPEED          = 3.5;
  const ANT_CARRY_AMOUNT   = 100;
  const FOOD_PER_ANT_SPAWN = 1;     // food cost to spawn 1 ant
  const SPAWN_INTERVAL     = 1;    // ticks between auto-spawn attempts
  const MAX_ANTS           = 5050;

  /* ── ant FSM states ────────────────────────────────────── */
  const ANT_IDLE    = 'idle';
  const ANT_FORAGE  = 'forage';
  const ANT_RETURN  = 'return';

  /* ── helpers (use RNG, never Math.random) ──────────────── */

  function dist(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function moveToward(obj, tx, ty, speed) {
    const d = dist(obj.x, obj.y, tx, ty);
    if (d < speed) { obj.x = tx; obj.y = ty; return true; }
    obj.x += (tx - obj.x) / d * speed;
    obj.y += (ty - obj.y) / d * speed;
    return false;
  }

  /* ── tick ───────────────────────────────────────────────── */

  function tick() {
    const s   = TE.state;
    const rng = s.rng;
    if (!rng) return;

    s.gameTick++;

    // 1) Possibly spawn a new resource
    if (s.resources.length < MAX_RESOURCES && rng.next() < RESOURCE_SPAWN_CHANCE) {
      s.resources.push({
        id:     s.nextResId++,
        x:      rng.range(-WORLD_RADIUS, WORLD_RADIUS),
        y:      rng.range(-WORLD_RADIUS, WORLD_RADIUS),
        amount: rng.int(3, 12),
        type:   'food',
      });
      TE.markDirty();
    }

    // 2) Ant spawning (nest auto-spawns workers if affordable)
    if (s.gameTick % SPAWN_INTERVAL === 0 && s.nest.food >= FOOD_PER_ANT_SPAWN && s.ants.length < MAX_ANTS) {
      s.nest.food -= FOOD_PER_ANT_SPAWN;
      s.nest.population++;
      s.ants.push({
        id:      s.nextAntId++,
        x:       s.nest.x,
        y:       s.nest.y,
        state:   ANT_IDLE,
        targetX: 0,
        targetY: 0,
        carrying: 0,
      });
      TE.markDirty();
    }

    // 3) Update each ant
    for (const ant of s.ants) {
      switch (ant.state) {
        case ANT_IDLE: {
          // Pick a resource to forage
          if (s.resources.length) {
            const target = rng.pick(s.resources);
            ant.targetX = target.x;
            ant.targetY = target.y;
            ant.state   = ANT_FORAGE;
          }
          break;
        }
        case ANT_FORAGE: {
          const arrived = moveToward(ant, ant.targetX, ant.targetY, ANT_SPEED);
          if (arrived) {
            // Try to pick up food
            const res = s.resources.find(r => dist(ant.x, ant.y, r.x, r.y) < 5 && r.amount > 0);
            if (res) {
              const take = Math.min(ANT_CARRY_AMOUNT, res.amount);
              res.amount -= take;
              ant.carrying += take;
              if (res.amount <= 0) {
                s.resources = s.resources.filter(r => r.id !== res.id);
              }
            }
            ant.targetX = s.nest.x;
            ant.targetY = s.nest.y;
            ant.state   = ANT_RETURN;
          }
          break;
        }
        case ANT_RETURN: {
          const home = moveToward(ant, ant.targetX, ant.targetY, ANT_SPEED);
          if (home) {
            s.nest.food += ant.carrying;
            ant.carrying = 0;
            ant.state = ANT_IDLE;
            TE.markDirty();
          }
          break;
        }
      }
    }
  }

  TE.gameTick = tick;
  TE.WORLD_RADIUS = WORLD_RADIUS;
})();
