/**
 * tiny-empire/server/tests/server.test.js
 *
 * Tests:
 *   1. Auth required for save (401 on missing/invalid token)
 *   2. Save round-trip write/read
 *   3. Schema migration path
 *   4. Payload size limit enforcement
 *   5. Retention pruning keeps only 10 newest saves
 *
 * Pattern: mirrors harbors-edge/server/tests/engine.test.js
 * Run:  node tests/server.test.js
 */
const assert    = require('assert');
const fs        = require('fs');
const path      = require('path');
const auth      = require('../src/auth');
const saveUtils = require('../src/saveUtils');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function cleanDataDir() {
  const dataDir = saveUtils.DATA_DIR;
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
}

function makeSave(overrides) {
  return Object.assign({
    saveSchemaVersion: saveUtils.SAVE_SCHEMA_VERSION,
    gameTick: 100,
    rngSeed: 42,
    nest: { x: 0, y: 0, food: 50, population: 5 },
    ants: [],
    resources: [],
  }, overrides);
}

/* ── setup ───────────────────────────────────────────────── */
cleanDataDir();
auth._resetForTest();

console.log('\n=== Tiny Empire Server Tests ===\n');

/* ── 1. Auth required for save ───────────────────────────── */
console.log('Auth:');

test('resolveToken returns invalid_token for garbage', () => {
  const r = auth.resolveToken('garbage');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_token');
});

test('resolveToken returns invalid_token for null', () => {
  const r = auth.resolveToken(null);
  assert.strictEqual(r.ok, false);
});

test('register then resolveToken succeeds', () => {
  const reg = auth.register('Tester', 'tester1', 'pass123');
  assert.strictEqual(reg.ok, true);
  assert.ok(reg.token);
  const r = auth.resolveToken(reg.token);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accountId, reg.account.id);
});

/* ── 2. Save round-trip write/read ───────────────────────── */
console.log('\nSave round-trip:');

test('writeSave + loadSave round-trips correctly', () => {
  cleanDataDir();
  const accountId = 'u_test_roundtrip';
  const payload = makeSave({ gameTick: 999 });
  const date = new Date('2026-03-03T12:30:45Z');
  const result = saveUtils.writeSave(accountId, payload, date);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.savedAt, '20260303-123045');
  assert.strictEqual(result.filename, '20260303-123045.json');

  const loaded = saveUtils.loadSave(accountId, '20260303-123045');
  assert.ok(loaded);
  assert.strictEqual(loaded.gameTick, 999);
  assert.strictEqual(loaded.saveSchemaVersion, saveUtils.SAVE_SCHEMA_VERSION);
});

test('loadLatestSave returns newest', () => {
  cleanDataDir();
  const accountId = 'u_test_latest';
  saveUtils.writeSave(accountId, makeSave({ gameTick: 1 }), new Date('2026-01-01T00:00:00Z'));
  saveUtils.writeSave(accountId, makeSave({ gameTick: 2 }), new Date('2026-01-02T00:00:00Z'));
  const latest = saveUtils.loadLatestSave(accountId);
  assert.ok(latest);
  assert.strictEqual(latest.gameTick, 2);
});

/* ── 3. Schema migration path ────────────────────────────── */
console.log('\nMigration:');

test('migrateSave returns current-version save unchanged', () => {
  const save = makeSave();
  const migrated = saveUtils.migrateSave(save);
  assert.strictEqual(migrated.saveSchemaVersion, saveUtils.SAVE_SCHEMA_VERSION);
});

test('migrateSave throws on missing migration step', () => {
  const oldSave = makeSave({ saveSchemaVersion: 0 });
  assert.throws(() => saveUtils.migrateSave(oldSave), /no migration from v0/);
});

test('custom migration is applied', () => {
  // Temporarily add a migration from 0 → 1
  saveUtils.migrations[0] = (s) => {
    s.saveSchemaVersion = 1;
    s.migrated = true;
    return s;
  };
  const old = makeSave({ saveSchemaVersion: 0 });
  const result = saveUtils.migrateSave(old);
  assert.strictEqual(result.saveSchemaVersion, 1);
  assert.strictEqual(result.migrated, true);
  delete saveUtils.migrations[0]; // clean up
});

/* ── 4. Payload size limit enforcement ───────────────────── */
console.log('\nPayload validation:');

test('validateSavePayload rejects missing required keys', () => {
  const r = saveUtils.validateSavePayload({ saveSchemaVersion: 1 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('missing_key'));
});

test('validateSavePayload rejects negative gameTick', () => {
  const r = saveUtils.validateSavePayload(makeSave({ gameTick: -1 }));
  assert.strictEqual(r.ok, false);
});

test('validateSavePayload accepts valid save', () => {
  const r = saveUtils.validateSavePayload(makeSave());
  assert.strictEqual(r.ok, true);
});

test('MAX_PAYLOAD_BYTES is 256 KiB', () => {
  assert.strictEqual(saveUtils.MAX_PAYLOAD_BYTES, 256 * 1024);
});

/* ── 5. Retention pruning keeps only 10 newest ───────────── */
console.log('\nRetention pruning:');

test('pruneOldSaves keeps only 10 newest saves', () => {
  cleanDataDir();
  const accountId = 'u_test_prune';
  // Create 12 saves with ascending timestamps
  for (let i = 0; i < 12; i++) {
    const d = new Date(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`);
    saveUtils.writeSave(accountId, makeSave({ gameTick: i }), d);
  }
  const remaining = saveUtils.listSaves(accountId);
  assert.strictEqual(remaining.length, 10, `Expected 10 saves, got ${remaining.length}`);
  // Newest first — first entry should be Jan 12
  assert.strictEqual(remaining[0], '20260112-000000.json');
  // Oldest kept should be Jan 3
  assert.strictEqual(remaining[9], '20260103-000000.json');
});

/* ── Rate limiter ────────────────────────────────────────── */
console.log('\nRate limiter:');

test('RateLimiter allows up to max, then blocks', () => {
  const rl = new saveUtils.RateLimiter(3, 60000);
  assert.strictEqual(rl.allow('a'), true);
  assert.strictEqual(rl.allow('a'), true);
  assert.strictEqual(rl.allow('a'), true);
  assert.strictEqual(rl.allow('a'), false);
  // Different key still allowed
  assert.strictEqual(rl.allow('b'), true);
});

/* ── safe paths ──────────────────────────────────────────── */
console.log('\nSafe paths:');

test('safeUserDir strips dangerous characters', () => {
  const dir = saveUtils.safeUserDir('u../../../etc/passwd');
  assert.ok(!dir.includes('..'));
  assert.ok(!dir.includes('/etc'));
});

test('safeUserDir throws on empty input', () => {
  assert.throws(() => saveUtils.safeUserDir(''), /invalid accountId/);
});

/* ── UTC timestamp format ────────────────────────────────── */
console.log('\nTimestamp format:');

test('utcTimestamp produces YYYYMMDD-HHMMSS fixed-width', () => {
  const ts = saveUtils.utcTimestamp(new Date('2026-03-03T08:05:09Z'));
  assert.strictEqual(ts, '20260303-080509');
  assert.strictEqual(ts.length, 15);
});

/* ── summary ─────────────────────────────────────────────── */
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
