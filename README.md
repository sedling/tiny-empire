# Tiny Empire

A 2D top-down ant colony game about resource management and survival.

## Quick Start

```bash
cd tiny-empire/server
npm install
npm start          # serves client + API on port 3010
```

Open `http://<your-server>:3010/` in a browser.

## Architecture

| Layer | Tech | Purpose |
|-------|------|---------|
| Client | Vanilla JS + Canvas | Simulation, rendering, input |
| Server | Node.js (http + ws) | Auth, save/load REST API, WS keepalive |

**Same-origin**: the Node server serves both static client files and the API — no CORS, no separate static server.

## Save System

- Client-side truth: simulation runs locally; server stores saves only.
- Saves are per-user JSON files at `server/data/<userid>/YYYYMMDD-HHMMSS.json`.
- Autosave every 3 minutes (if dirty) + immediate save on major events.
- Retention: 10 newest saves per user; older saves auto-pruned.
- Schema versioned (`SAVE_SCHEMA_VERSION`); server migrates older saves on load.

## Auth

Mirrors the harbors-edge auth flow (register / login / resume with opaque session tokens). See `INSTRUCTIONS.md` for full endpoint docs.

## Development

See `INSTRUCTIONS.md` for:
- Complete endpoint reference
- Version-bump rules for cache busting
- Autosave cadence and major-event hooks
- Save schema migration guide
