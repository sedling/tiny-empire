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

  /* ── main draw ─────────────────────────────────────────── */

  function draw() {
    const s = TE.state;
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Ground
    ctx.fillStyle = '#2d5a27';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // World boundary circle (subtle)
    const center = worldToScreen(0, 0);
    ctx.beginPath();
    ctx.arc(center.x, center.y, TE.WORLD_RADIUS * camera.zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Resources (food = yellow dots)
    for (const r of s.resources) {
      const size = 3 + r.amount * 0.4;
      drawCircle(r.x, r.y, size, '#facc15');
    }

    // Nest (brown circle with outline)
    drawCircle(s.nest.x, s.nest.y, 18, '#8B4513');
    drawCircle(s.nest.x, s.nest.y, 14, '#654321');

    // Ants (small red dots; carrying = brighter)
    for (const a of s.ants) {
      const col = a.carrying > 0 ? '#ff6b6b' : '#e94560';
      drawCircle(a.x, a.y, 3, col);
    }
  }

  TE.renderer = { init, draw, camera, worldToScreen, resize };
})();
