/**
 * tiny-empire/client/js/input.js
 *
 * Mouse / touch camera pan and zoom.
 * Click interactions can be extended to issue ant orders.
 */
(function () {
  'use strict';
  const TE = window.TinyEmpire = window.TinyEmpire || {};

  let dragging = false;
  let lastX = 0, lastY = 0;

  function init(canvas) {
    const cam = TE.renderer.camera;

    /* ── mouse ───────────────────────────────────────────── */
    canvas.addEventListener('mousedown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      cam.x -= dx / cam.zoom;
      cam.y -= dy / cam.zoom;
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      cam.zoom = Math.max(0.2, Math.min(5, cam.zoom * factor));
    }, { passive: false });

    /* ── touch (single-finger pan) ───────────────────────── */
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        dragging = true;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
      }
    });
    canvas.addEventListener('touchmove', (e) => {
      if (!dragging || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - lastX;
      const dy = e.touches[0].clientY - lastY;
      cam.x -= dx / cam.zoom;
      cam.y -= dy / cam.zoom;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    }, { passive: false });
    canvas.addEventListener('touchend', () => { dragging = false; });
  }

  TE.input = { init };
})();
