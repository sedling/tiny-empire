/**
 * tiny-empire/server/src/saveUtils.js
 *
 * Save-file utilities: schema versioning, validation, migration,
 * atomic writes, retention pruning, safe path mapping, and rate limiting.
 *
 * Compatibility: atomic-write pattern mirrors
 *   harbors-edge/server/server.js  atomicWriteFile (L131-L168)
 *   harbors-edge/server/src/auth.js  saveStore      (L190-L230)
 */
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ── constants ───────────────────────────────────────────── */

/** Bump this when the save schema changes; add a migration step below. */
const SAVE_SCHEMA_VERSION = 1;

/** Maximum save JSON payload in bytes (256 KiB). */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Number of newest saves to keep per user. */
const RETENTION_COUNT = 10;

const DATA_DIR = path.join(__dirname, '..', 'data');

/* ── safe userid → directory mapping ─────────────────────── */

/**
 * Convert an accountId to a safe directory name.
 * Only alphanumeric, underscore, and hyphen chars are kept.
 * Never use raw user input as a path component.
 */
function safeUserDir(accountId) {
  const safe = String(accountId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('invalid accountId for path mapping');
  return path.join(DATA_DIR, safe);
}

/* ── timestamp helpers ───────────────────────────────────── */

/**
 * UTC fixed-width timestamp for save filenames.
 * Format: YYYYMMDD-HHMMSS  (lexicographic == chronological).
 */
function utcTimestamp(date) {
  const d = date || new Date();
  const Y = String(d.getUTCFullYear());
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${Y}${M}${D}-${h}${m}${s}`;
}

/* ── validation ──────────────────────────────────────────── */

/**
 * Validate a save payload.
 * Returns { ok:true } or { ok:false, reason }.
 */
function validateSavePayload(save) {
  if (!save || typeof save !== 'object' || Array.isArray(save)) {
    return { ok: false, reason: 'payload_not_object' };
  }

  // Required top-level keys
  const requiredKeys = ['saveSchemaVersion', 'gameTick', 'rngSeed'];
  for (const key of requiredKeys) {
    if (!(key in save)) return { ok: false, reason: `missing_key:${key}` };
  }

  // Types & ranges
  if (typeof save.saveSchemaVersion !== 'number' || !Number.isInteger(save.saveSchemaVersion) || save.saveSchemaVersion < 1) {
    return { ok: false, reason: 'invalid_saveSchemaVersion' };
  }
  if (typeof save.gameTick !== 'number' || !Number.isFinite(save.gameTick) || save.gameTick < 0) {
    return { ok: false, reason: 'invalid_gameTick' };
  }
  if (typeof save.rngSeed !== 'number' || !Number.isFinite(save.rngSeed)) {
    return { ok: false, reason: 'invalid_rngSeed' };
  }

  // Nest (optional at v1; required in future versions)
  if (save.nest !== undefined) {
    if (typeof save.nest !== 'object' || save.nest === null) {
      return { ok: false, reason: 'invalid_nest' };
    }
    if (typeof save.nest.food !== 'number' || save.nest.food < 0) {
      return { ok: false, reason: 'invalid_nest.food' };
    }
    if (typeof save.nest.population !== 'number' || save.nest.population < 0) {
      return { ok: false, reason: 'invalid_nest.population' };
    }
  }

  return { ok: true };
}

/* ── migration ───────────────────────────────────────────── */

/**
 * Migration registry.
 * Each entry upgrades from version N to N+1.
 * Add new functions here when SAVE_SCHEMA_VERSION is bumped.
 */
const migrations = {
  // Example: 1→2 would go here:
  // 1: (save) => { save.newField = 'default'; save.saveSchemaVersion = 2; return save; },
};

/**
 * Iteratively migrate a save to SAVE_SCHEMA_VERSION.
 * Returns the (possibly mutated) save object.
 * Throws if a required migration step is missing.
 */
function migrateSave(save) {
  if (!save || typeof save !== 'object') throw new Error('migrateSave: invalid save');
  let v = save.saveSchemaVersion;
  if (typeof v !== 'number') throw new Error('migrateSave: missing saveSchemaVersion');
  while (v < SAVE_SCHEMA_VERSION) {
    const fn = migrations[v];
    if (!fn) throw new Error(`migrateSave: no migration from v${v} to v${v + 1}`);
    save = fn(save);
    v = save.saveSchemaVersion;
  }
  return save;
}

/* ── atomic write ────────────────────────────────────────── */

/**
 * Atomic write: create temp file in the same directory, then rename.
 * Pattern from harbors-edge/server/server.js atomicWriteFile.
 */
function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpName, content, 'utf8');
  try {
    fs.renameSync(tmpName, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpName); } catch (_) { /* ignore */ }
    throw err;
  }
}

/* ── list / load / prune ─────────────────────────────────── */

/** List save filenames for a user, newest-first (lexicographic descending). */
function listSaves(accountId) {
  const dir = safeUserDir(accountId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .sort()
    .reverse();   // newest first
}

/** Load a specific save by timestamp string. Returns parsed JSON or null. */
function loadSave(accountId, timestamp) {
  const safe = String(timestamp).replace(/[^0-9-]/g, '');
  if (!safe) return null;
  const filePath = path.join(safeUserDir(accountId), `${safe}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Load the latest save for a user. Returns { save, savedAt } or null. */
function loadLatestSave(accountId) {
  const files = listSaves(accountId);
  if (!files.length) return null;
  const ts = files[0].replace('.json', '');
  const save = loadSave(accountId, ts);
  if (!save) return null;
  return { save, savedAt: ts };
}

/**
 * Write a save file and prune old saves beyond RETENTION_COUNT.
 * Returns { ok, filename, savedAt } or { ok:false, reason }.
 */
function writeSave(accountId, payload, nowDate) {
  const ts = utcTimestamp(nowDate);
  const dir = safeUserDir(accountId);
  const filename = `${ts}.json`;
  const filePath = path.join(dir, filename);

  atomicWriteFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  pruneOldSaves(accountId);

  return { ok: true, filename, savedAt: ts };
}

/** Keep only the newest RETENTION_COUNT saves for a user. */
function pruneOldSaves(accountId) {
  const files = listSaves(accountId); // already newest-first
  if (files.length <= RETENTION_COUNT) return;
  const dir = safeUserDir(accountId);
  const toRemove = files.slice(RETENTION_COUNT);
  for (const f of toRemove) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
  }
}

/* ── in-memory rate limiter ──────────────────────────────── */

/**
 * Simple sliding-window rate limiter per key (accountId or IP).
 * Allows `max` requests per `windowMs`.
 */
class RateLimiter {
  constructor(max = 6, windowMs = 60000) {
    this.max      = max;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.hits     = new Map();
  }

  /** Returns true if the request is allowed; false if rate-limited. */
  allow(key) {
    const now = Date.now();
    let times = this.hits.get(key);
    if (!times) { times = []; this.hits.set(key, times); }
    // Evict old entries
    while (times.length && times[0] <= now - this.windowMs) times.shift();
    if (times.length >= this.max) return false;
    times.push(now);
    return true;
  }

  /** Reset (for tests). */
  reset() { this.hits.clear(); }
}

/* ── exports ─────────────────────────────────────────────── */

module.exports = {
  SAVE_SCHEMA_VERSION,
  MAX_PAYLOAD_BYTES,
  RETENTION_COUNT,
  DATA_DIR,
  safeUserDir,
  utcTimestamp,
  validateSavePayload,
  migrateSave,
  migrations,
  atomicWriteFile,
  listSaves,
  loadSave,
  loadLatestSave,
  writeSave,
  pruneOldSaves,
  RateLimiter,
};
