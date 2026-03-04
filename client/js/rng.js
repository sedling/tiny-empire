/**
 * tiny-empire/client/js/rng.js
 *
 * Seeded pseudo-random number generator (mulberry32).
 * Simulation code must NEVER call Math.random() or Date.now().
 * Use TinyEmpire.RNG exclusively.
 */
(function () {
  'use strict';
  window.TinyEmpire = window.TinyEmpire || {};

  /**
   * Mulberry32 — fast 32-bit seeded PRNG.
   * Returns a function that produces a float in [0, 1) each call.
   */
  function mulberry32(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * RNG wrapper that tracks the seed for save/load.
   */
  class RNG {
    constructor(seed) {
      this.initialSeed = seed;
      this._fn = mulberry32(seed);
    }
    /** Float in [0, 1). */
    next()        { return this._fn(); }
    /** Integer in [min, max) — max exclusive. */
    int(min, max) { return min + Math.floor(this._fn() * (max - min)); }
    /** Pick a random element from an array. */
    pick(arr)     { return arr[this.int(0, arr.length)]; }
    /** Float in [min, max). */
    range(min, max) { return min + this._fn() * (max - min); }
  }

  window.TinyEmpire.mulberry32 = mulberry32;
  window.TinyEmpire.RNG = RNG;
})();
