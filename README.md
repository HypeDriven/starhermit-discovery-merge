# Discovery Merge

Combine identical objects to unlock a branching discovery chain and restore themed scenes — an explorer's cabinet that grows into a living diorama.

## Run

```sh
node server.js          # serves the game + API on http://localhost:8080
```

Or serve the directory with any static file server — the game is fully playable offline (leaderboard/time-sync features degrade gracefully to local fallbacks).

## Test

```sh
npm test                # rules/content unit, property, fuzz, and winnability tests
node test/e2e.smoke.mjs # with the server running: replay-validated score submission
```

A headless QA hook is available at `?selftest=1` (plays a scripted practice round and reports on `<body data-selftest>`).

## Layout

- `index.html`, `css/` — semantic UI shell (menus, HUD, overlays; canvas is never the only UI)
- `src/engine/` — pure deterministic rules engine + seeded RNG (node-safe, unit-tested)
- `src/content.js` — chains, 5 themes, 40 journey stages, daily/challenge/practice generators, validator
- `src/session.js` — command log, undo, snapshots, replay envelopes
- `src/render.js` — Three.js board/diorama, quality tiers, pooled particles
- `src/ui.js` — DOM board (keyboard/screen-reader mirror + 2D fallback), input controller
- `src/audio.js` — synthesized WebAudio buses (music/effects/ambience)
- `src/platform.js` — same-origin `/api` adapter with offline fallbacks
- `src/persist.js` — versioned, checksummed local saves
- `server.js` — authoritative script: static hosting, server time, replay-validated daily leaderboard
- `starhermit.txt` — distribution manifest (`name`, `launch=index.html`, `server=server.js`)
