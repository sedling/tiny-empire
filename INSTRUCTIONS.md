# INSTRUCTIONS — Tiny Empire

> **These instructions are authoritative.** Every prompt that modifies this
> project must follow the rules below. If a rule is ambiguous, ask before
> proceeding.

---

## 1. Serving Model

Tiny Empire runs on **one Node process** that serves both the static client
and the REST / WebSocket API from the **same origin**.

```
tiny-empire/server/server.js   →  serves  tiny-empire/client/**
                                   exposes /api/*  (REST)
                                   exposes ws://   (keepalive only)
```

There is no separate static-file server. Do not introduce CORS headers or a
secondary origin.

---

## 2. Version Bumping (cache busting)

Every `<link>` and `<script>` tag in `client/index.html` uses a `?v=N` query
string.

**Rule:** after ANY change to a client-side file (`*.css`, `*.js`, or
`index.html` structure), **increment the `?v=` number** on the affected tag(s)
in `client/index.html` so the live site always serves the newest version on
refresh.

Example:
```html
<link rel="stylesheet" href="assets/styles.css?v=2" />
<script src="js/boot.js?v=2"></script>
```

---

## 3. REST Endpoints

All endpoints accept and return JSON. Authenticated endpoints require:

- **Primary:** `Authorization: Bearer <token>` header.
- **Fallback:** `{ "token": "<token>" }` field in the JSON body (harbors-edge
  compatibility only).

### Auth

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/register` | `{ loginName, visibleName, password }` | `{ ok, account, token }` |
| POST | `/api/login` | `{ loginName, password }` | `{ ok, account, token }` |
| POST | `/api/resume` | `{ token }` or Bearer header | `{ ok, account, token }` |

### Saves

| Method | Path | Auth? | Body / Params | Response |
|--------|------|-------|---------------|----------|
| POST | `/api/save` | Yes | Save payload JSON | `{ ok, filename, savedAt }` |
| GET | `/api/saves` | Yes | — | `{ ok, saves: [filenames] }` |
| GET | `/api/save/:timestamp` | Yes | timestamp = `YYYYMMDD-HHMMSS` | `{ ok, save }` |
| GET | `/api/save/latest` | Yes | — | `{ ok, save }` |

Auth compatibility notes:
- Token format: opaque string, prefix `t` + 24 hex chars (matches
  `harbors-edge/server/src/ids.js` `nextSessionToken()`).
- Tokens are stored server-side in `data/auth.json` sessions map.
- Client stores token in `localStorage` key `te_token`.
- Token expiry: currently infinite; add TTL check in `auth.resolveToken()`
  when needed.

---

## 4. WebSocket Keepalive

The WebSocket is used **only** for connection-status keepalive. Game state is
**never** sent over WS.

Protocol (app-level JSON, NOT WebSocket protocol-level ping frames):
1. Server sends `{ "type": "PING" }` every ~30 seconds.
2. Client replies with `{ "type": "PONG" }`.
3. If the server does not receive a PONG before the next PING interval, it
   terminates the connection.
4. Client reconnects automatically after 3 seconds.

Compatible with `harbors-edge/server/src/protocol.json` `PING` / `PONG`
values.

---

## 5. Save Format & Storage

### File layout

```
server/data/<safe-userid>/YYYYMMDD-HHMMSS.json
```

- `<safe-userid>` is the `accountId` with non-alphanumeric characters stripped
  (never use raw user input as a path).
- Timestamp is **UTC, fixed-width** `YYYYMMDD-HHMMSS` so **lexicographic
  order == chronological order**.

### Schema versioning

Every save contains a top-level `saveSchemaVersion` integer.

```json
{
  "saveSchemaVersion": 1,
  "gameTick": 12000,
  "rngSeed": 3141592653,
  "nest": { "x": 0, "y": 0, "food": 42, "population": 12 },
  "ants": [ ... ],
  "resources": [ ... ]
}
```

- `SAVE_SCHEMA_VERSION` constant lives in `server/src/saveUtils.js`.
- `migrateSave(save)` iteratively upgrades older saves. Add migration
  functions to the `migrations` registry object keyed by source version:
  ```js
  migrations[1] = (save) => { save.newField = 'default'; save.saveSchemaVersion = 2; return save; };
  ```

### Validation

Server validates every save payload before writing:
- Required keys: `saveSchemaVersion`, `gameTick`, `rngSeed`.
- Numeric ranges: `gameTick >= 0`, `rngSeed` is finite.
- Nest fields (if present): `food >= 0`, `population >= 0`.
- Payload size: max **256 KiB** (rejects with 413).

### Atomic writes

Writes use temp-file-in-same-directory then `rename()` (pattern from
`harbors-edge/server/server.js` `atomicWriteFile`). No mandatory fsync.

### Retention

After each successful save the server **prunes** and keeps only the **10
newest** saves per user. Older files are deleted.

### .gitignore

Player data must **never** be committed:
```
server/data/**
!server/data/.gitkeep
```

---

## 6. Rate Limiting

- In-memory sliding-window rate limiter per accountId for save endpoints.
- Default: **6 saves per 60 seconds** per user.
- Pattern inspired by `harbors-edge/server/server.js` token-bucket rate
  limiter (L920-L956).

---

## 7. Autosave Policy

| Trigger | Interval | Condition |
|---------|----------|-----------|
| Timer | Every **3 minutes** | Only if `state.dirty === true` |
| Major event | Immediate | Event name is in `MajorEventRegistry` |

### Major-event registry

Edit `client/js/net.js` → `MajorEventRegistry` Set to add/remove triggers:

```js
const MajorEventRegistry = new Set([
  'nestSpawned',
  'nestDestroyed',
  'resourceDepleted',
  'colonyLost',
  'antSpawned',
]);
```

Game code fires events via `TE.majorEvent('eventName')`.

### Backoff & HUD status

On failed saves the client uses **exponential backoff** (5 s → 2× → cap 10 min).

HUD save status indicator values:
- `saving` — request in flight
- `saved`  — last save succeeded (shows timestamp)
- `error`  — last save failed (shows reason)
- `offline`— WebSocket disconnected

---

## 8. Simulation

- **Fixed timestep:** 20 ticks/sec (50 ms per tick).
- `gameTick` integer in state increments each tick.
- Rendering runs on `requestAnimationFrame`, decoupled from simulation.
- **Seeded RNG:** mulberry32 in `client/js/rng.js`. `rngSeed` stored in save.
- **Hard rule:** simulation code must **never** call `Date.now()` or
  `Math.random()`. Use `state.rng.next()`, `state.rng.int()`, etc.

---

## 9. Client Modules

| File | Responsibility |
|------|----------------|
| `js/rng.js` | Seeded PRNG (mulberry32) |
| `js/state.js` | Game state, dirty flag, serialise/deserialise |
| `js/game.js` | Colony simulation (nest, ants, resources, foraging AI) |
| `js/renderer.js` | Canvas drawing, camera |
| `js/input.js` | Mouse/touch pan & zoom |
| `js/ui.js` | HUD updates |
| `js/net.js` | REST API calls, WS keepalive, autosave engine, major-event registry |
| `js/boot.js` | Auth UI wiring, game loop startup |

---

## 10. Server Modules

| File | Responsibility |
|------|----------------|
| `server.js` | HTTP server, static serving, REST router, WS keepalive |
| `src/auth.js` | Register/login/resume, token management, store persistence |
| `src/ids.js` | User-ID and session-token generation |
| `src/saveUtils.js` | Save schema, validation, migration, atomic write, pruning, rate limiter |

Compatibility contract — these mirror minimal surface area from:
- `harbors-edge/server/src/auth.js` — createSession, register, login, resume
- `harbors-edge/server/src/ids.js` — nextUserId, nextSessionToken
- `harbors-edge/server/server.js` — atomicWriteFile, rate limiter pattern
- `harbors-edge/server/src/protocol.json` — PING / PONG message types

---

## 11. Tests

Run: `cd server && npm test`

Covers:
1. Auth required for save (401 on missing/invalid token)
2. Save round-trip write/read
3. Schema migration path
4. Payload size limit enforcement
5. Retention pruning keeps only 10 newest saves

---

## 12. Launcher Integration

To add Tiny Empire to the site launcher, add an entry in the root `base.js`
(see lines ~600-740) pointing to `/tiny-empire/client/index.html`. Bump the
version query string on the launcher entry as well.

---

## 13. Patches & Changes

When releasing changes, follow the repo's existing patch workflow:
- Create a patch file under the appropriate version directory.
- Update ROADMAP/CHANGES documentation if present.
