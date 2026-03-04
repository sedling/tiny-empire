/**
 * tiny-empire/server/src/auth.js
 *
 * Minimal auth surface for register / login / resume.
 * Compatibility contract: mirrors harbors-edge/server/src/auth.js
 *   - createSession, register, login, resume
 *   - Token format from harbors-edge/server/src/ids.js (prefix 't' + 24 hex chars)
 *   - Password hashing: scrypt with random salt
 *   - Store persisted to data/auth.json via atomic write (temp-in-same-dir → rename)
 */
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nextUserId, nextSessionToken } = require('./ids');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const STORE_PATH  = path.join(DATA_DIR, 'auth.json');
const SCHEMA_VERSION = 1;

/* ── helpers ─────────────────────────────────────────────── */

function emptyStore() {
  return { schema: SCHEMA_VERSION, accounts: {}, loginNames: {}, sessions: {} };
}

function normalizeLoginName(name) {
  return String(name || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, passwordHash) {
  if (typeof passwordHash !== 'string') return false;
  const parts = passwordHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const derived = crypto.scryptSync(String(password), parts[1], 64).toString('hex');
  const a = Buffer.from(parts[2], 'hex');
  const b = Buffer.from(derived, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ── atomic persistence ──────────────────────────────────── */

function atomicWriteStore(txt) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpName = `${STORE_PATH}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpName, txt, 'utf8');
  try {
    fs.renameSync(tmpName, STORE_PATH);
  } catch (_err) {
    try { fs.unlinkSync(tmpName); } catch (_) { /* ignore */ }
    throw _err;
  }
}

/* ── store lifecycle ─────────────────────────────────────── */

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return emptyStore();
  let raw;
  try { raw = fs.readFileSync(STORE_PATH, 'utf8'); } catch (_) { return emptyStore(); }
  let data;
  try { data = JSON.parse(raw); } catch (_) { return emptyStore(); }
  if (!data || typeof data !== 'object' || data.schema !== SCHEMA_VERSION) return emptyStore();
  return {
    schema: SCHEMA_VERSION,
    accounts:   data.accounts   || {},
    loginNames: data.loginNames || {},
    sessions:   data.sessions   || {},
  };
}

let store = loadStore();

function saveStore() {
  const payload = {
    schema: SCHEMA_VERSION,
    accounts:   store.accounts,
    loginNames: store.loginNames,
    sessions:   store.sessions,
  };
  atomicWriteStore(JSON.stringify(payload, null, 2) + '\n');
}

/* ── public API ──────────────────────────────────────────── */

function createSession(accountId) {
  const token = nextSessionToken();
  store.sessions[token] = { accountId, createdAt: Date.now() };
  saveStore();
  return token;
}

function getAccount(accountId) {
  return store.accounts[accountId] || null;
}

function register(visibleName, loginName, password) {
  const lname = normalizeLoginName(loginName);
  const vname = String(visibleName || '').trim();
  if (!lname || !vname || !password) return { ok: false, reason: 'invalid_input' };
  if (store.loginNames[lname]) return { ok: false, reason: 'login_name_taken' };

  const accountId = nextUserId();
  const now = Date.now();
  const account = {
    id: accountId,
    loginName: lname,
    visibleName: vname,
    passwordHash: hashPassword(password),
    createdAt: now,
    updatedAt: now,
  };
  store.accounts[accountId] = account;
  store.loginNames[lname]   = accountId;
  const token = createSession(accountId);
  return { ok: true, account: safeAccount(account), token };
}

function login(loginName, password) {
  const lname = normalizeLoginName(loginName);
  if (!lname || !password) return { ok: false, reason: 'invalid_input' };
  const accountId = store.loginNames[lname];
  if (!accountId) return { ok: false, reason: 'no_such_user' };
  const account = store.accounts[accountId];
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return { ok: false, reason: 'wrong_password' };
  }
  const token = createSession(accountId);
  return { ok: true, account: safeAccount(account), token };
}

function resume(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'invalid_token' };
  const sess = store.sessions[token];
  if (!sess) return { ok: false, reason: 'invalid_token' };
  const account = getAccount(sess.accountId);
  if (!account) return { ok: false, reason: 'invalid_token' };
  return { ok: true, account: safeAccount(account), token };
}

/** Strip sensitive fields before sending to client. */
function safeAccount(acc) {
  if (!acc) return null;
  return { id: acc.id, loginName: acc.loginName, visibleName: acc.visibleName };
}

/**
 * Resolve accountId from a Bearer token string.
 * Returns { ok, accountId, account } or { ok:false, reason }.
 */
function resolveToken(token) {
  const r = resume(token);
  if (!r.ok) return r;
  return { ok: true, accountId: r.account.id, account: r.account };
}

/** Reset in-memory store (for tests). */
function _resetForTest() {
  store = emptyStore();
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
}

module.exports = {
  register,
  login,
  resume,
  resolveToken,
  getAccount,
  _resetForTest,
  DATA_DIR,
};
