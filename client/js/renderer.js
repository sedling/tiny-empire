/**
 * tiny-empire/client/js/renderer.js
 *
 * Top-down 2D canvas renderer.
 * Reads state but never mutates it.
 * Camera pan/zoom is driven by input.js.
 */
(function () {
  'use strict';
  const TE = window.TinyEmpire = window.TinyEmpire || {};

  let canvas, ctx;
  const camera = { x: 0, y: 0, zoom: 1 };

  function init(canvasEl) {
    canvas = canvasEl;
    ctx    = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  /* ── coordinate transforms ─────────────────────────────── */

  function worldToScreen(wx, wy) {
    return {
      x: (wx - camera.x) * camera.zoom + canvas.width  / 2,
      y: (wy - camera.y) * camera.zoom + canvas.height / 2,
    };
  }

  /* ── draw helpers ──────────────────────────────────────── */

  function drawCircle(wx, wy, radius, fill) {
    const p = worldToScreen(wx, wy);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * camera.zoom, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawSquare(wx, wy, halfSize, fill) {
    const p = worldToScreen(wx, wy);
    const s = halfSize * camera.zoom;
    ctx.fillStyle = fill;
    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
  }

  function cargoColor(type) {
    if (type === 'food') return '#facc15';
    if (type === 'sugar') return '#ffffff';
    return '#facc15';
  }

  /* ── main draw ─────────────────────────────────────────── */

  function draw() {
    const s = TE.state;
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Ground
    ctx.fillStyle = '#2d5a27';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (TE.roadConfig && TE.roadConfig.visualEnabled) {
      const roads = s.roadTraffic;
      if (roads && roads.activeCells && roads.activeCells.length > 0) {
        const cellSize = roads.cellSize || 24;
        const drawSize = cellSize * camera.zoom;
        ctx.fillStyle = '#b89557';
        for (let i = 0; i < roads.activeCells.length; i++) {
          const cell = roads.activeCells[i];
          const alpha = cell.heat * 0.28;
          if (alpha <= 0.01) continue;
          const topLeft = worldToScreen(cell.cx * cellSize, cell.cy * cellSize);
          if (topLeft.x + drawSize < 0 || topLeft.y + drawSize < 0 || topLeft.x > canvas.width || topLeft.y > canvas.height) {
            continue;
          }
          ctx.globalAlpha = alpha > 0.35 ? 0.35 : alpha;
          ctx.fillRect(topLeft.x, topLeft.y, drawSize, drawSize);
        }
        ctx.globalAlpha = 1;
      }
    }

    // World boundary square (darker, shows spawn region)
    const worldSize = (TE.WORLD_RADIUS || 2000) * 2 * camera.zoom;
    const worldTopLeft = worldToScreen(-TE.WORLD_RADIUS, -TE.WORLD_RADIUS);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(worldTopLeft.x, worldTopLeft.y, worldSize, worldSize);

    // Nest gathering zone circle (solid yellow) - use state-defined radius if present
    const nestPos = worldToScreen(s.nest.x, s.nest.y);
    const gatherRadius = (s.nest && s.nest.gatherRadius) ? s.nest.gatherRadius : (TE.NEST_GATHERING_RADIUS || 800);
    ctx.beginPath();
    ctx.arc(nestPos.x, nestPos.y, gatherRadius * camera.zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Resources (food = yellow dots, sugar = white small squares)
    for (const r of s.resources) {
      if (r.type === 'sugar') {
        const halfSide = 2 + r.amount * 0.2; // half-side in world units
        drawSquare(r.x, r.y, halfSide, '#ffffff');
      } else {
        const size = 3 + r.amount * 0.4;
        drawCircle(r.x, r.y, size, '#facc15');
      }
    }

    // Nest (brown circle with outline)
    drawCircle(s.nest.x, s.nest.y, 18, '#8B4513');
    drawCircle(s.nest.x, s.nest.y, 14, '#654321');

    // Ants + carried cargo blob
    for (const a of s.ants) {
      if (a.inNest) continue;
      const col = a.carrying > 0 ? '#ff6b6b' : '#e94560';
      drawCircle(a.x, a.y, 3, col);
      if (a.carrying > 0) {
        if (a.carryType === 'sugar') {
          // Small sugar square carried by the ant
          drawSquare(a.x + 3, a.y - 3, 1.2, cargoColor('sugar'));
        } else {
          drawCircle(a.x + 3, a.y - 3, 1.5, cargoColor(a.carryType));
        }
      }
    }
  }

  TE.renderer = { init, draw, camera, worldToScreen, resize };
})();
