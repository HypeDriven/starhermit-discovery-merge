# Known Issues — Discovery Merge

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and end-to-end smoke.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node --test tests/*.test.mjs`) | 27/27 pass, 0 fail |
| `node --check` on all modules | clean (`src/**/*.js`, `server.js`, `tests/*.mjs`) |
| `tests/e2e.smoke.mjs` (against a running `node server.js`) | PASS — valid submission ranked, tampered score rejected with `score-mismatch`, board readback correct |
| `npm run test:e2e` (`node tests/e2e.mjs`, headless Chrome desktop 1280x800 + mobile 390x844) | PASS — played stage 1 to a win on both viewports, no page errors |
| HTTP fuzz of `server.js` (directories, traversal, malformed encodings, 20 malformed bodies + odd query strings on all 6 API routes) | survived; no crash, no traversal |

## Resolved defects

All three were reproduced against a running copy of `server.js`, fixed surgically in `server.js`, and
re-verified (see the verification notes in each section).

### 1. Any future daily board can be pre-solved and pre-populated — RESOLVED (2026-09-05)

- **Fix:** `server.js` — added `utcToday()`/`startOfUtcDay()` helpers and a guard in the daily submit
  path that accepts only the current UTC day: `if (date !== utcToday()) return json(res, 400,
  { error: 'not-today' })` (was `server.js:148`; originally the date check at `server.js:130-143` only
  shape-tested the string). Per spec.md §2 the daily mode is one shared seed/ruleset per UTC day
  synchronized to platform time, and immutable seeds presume publication is a point in time.
- **Verification:** submitting `date: "2027-06-01"` now returns `{"error":"not-today"}` (and writes
  nothing). `e2e.smoke.mjs` still passes because it submits the current UTC date.

### 2. Elapsed time is client-declared and decides ties — RESOLVED (2026-09-05)

- **Fix:** `server.js` — the stored `seconds` is now derived from the server clock, never the client's
  claim: `seconds: Math.max(0, Math.min(86400, Math.round((now - startOfUtcDay(date)) / 1000)))`
  (`server.js:~185`; was `seconds: Math.max(0, Math.min(86400, claimed.elapsedSeconds | 0))`). Per
  spec.md §2 ties use "lower authoritative elapsed time", so a client-declared zero can no longer win a
  tie. Pre-command timestamps are not in the replay envelope, so the only authoritative server-side
  anchor is time since the daily's UTC-day start.
- **Verification:** two byte-identical solves differing only in declared `elapsedSeconds` (900 vs 0) now
  receive identical server-derived `seconds` and are ordered by the stable session id — the board no
  longer ranks the zero-second claim first.

### 3. `x-player-id` is unauthenticated, so one client can overwrite another player's board entry — RESOLVED (2026-09-05)

- **Fix:** `server.js` — removed the `x-player-id` header from identity resolution: `const playerId =
  name;` (`server.js:175`; was `req.headers['x-player-id'] || name`). Per spec.md §6 board identity comes
  from the host's verified identity, not a client-settable header used as the primary key; in this
  no-auth local board the display name is the identity (the "casual local board" fallback). The header is
  ignored rather than trusted, so pointing it at another player's id can no longer trick the
  replace-if-better logic into clobbering their row.
- **Verification:** submitting with `x-player-id: honest` and a different `name` no longer replaces the
  `honest` entry; it adds a distinct row under the submitted name and `honest` is preserved.
- **Remaining limitation (not fixed, out of scope here):** this local board has no host-injected
  authenticated identity, so a client could still submit under *another player's display name* directly.
  Fully closing that needs the host's verified/signed identity binding, which the offline casual board
  deliberately does not implement.

## Suspected — not confirmed

### 1. Only one merge direction is enumerated per pair

- **File:** `src/engine/rules.js:144+` (`legalActions`, the `q.cell > p.cell` pair loop)
- **Concern:** for two mergeable non-webbed pieces, only the lower-cell → higher-cell direction is
  offered, so the player cannot choose which cell receives the upgraded piece. On a board where free
  cells matter, that could make an otherwise-reachable position unreachable through the legal-action API.
- **Why unconfirmed:** the code is self-consistent with a deliberate "one action per pair" design, the
  shipped test "all journey levels + dailies are winnable by a greedy solver" passes, and spec.md does
  not state which cell should receive the result. This is a design question for a human.

## Checked, no defects found

- `src/engine/rules.js:1-215` — `maxTier`, `canMergeItems` (same chain, same tier, below max),
  `noteDiscovery` (highest tier per chain, points only on a new high), `requestNeedsPiece`,
  `legalActions` generator/merge/deliver/move enumeration, and `isValidShape`'s integer checks on
  `cell`/`from`/`to`.
- `src/engine/rules.js:132-138` (`requestNeedsPiece`) — reviewed as a suspected over-delivery bug and
  **disproved**: the guard is `n.chain === piece.chain && n.tier === piece.tier && req.progress[i] < n.count`,
  so a satisfied need is never matched and a piece cannot be absorbed into it.
- `src/engine/rules.js:263-264` — the `OUT_OF_MOVES` branch is indeed unreachable from any state
  `createGame` produces (`checkTerminal` at line 246 marks the session lost first, and line 263 rejects
  non-active states), but it is harmless defensive code, not a logic error.
- `server.js:134-150` — the submission path is sound: rules and content versions are pinned, the command
  array is length-capped at 20000, the level is rebuilt server-side from the date, `envelope.seed` is
  compared against it, the log is re-simulated, `state.status !== 'won'` is refused, and both the total
  score and the final state hash are re-derived and compared. A client cannot inflate a score or
  substitute its own level; defects 1-3 are about *which day*, *how fast* and *as whom*.
- `server.js:179-199` (`serveStatic`) — `normalize` plus a `startsWith(ROOT)` check, and explicit refusal
  of `/data/`, `server.js` and `spec.md`. Malformed percent-encodings throw inside the handler's
  `try/catch` (`server.js:201-209`) and surface as a 500 rather than killing the process — worth noting,
  because the same `decodeURIComponent(url.pathname)` pattern *does* crash two other games in this batch.
- `server.js:185` — reviewed as a suspected "the whole `src/` tree is exposed" leak and **disproved as a
  defect**: `index.html:128` loads the game with `<script type="module" src="src/main.js">`, so `src/`
  *is* the distribution surface for a no-build vanilla-JS game. The blocklist correctly covers the three
  things that are not (`/data/`, `server.js`, `spec.md`). The daily seeds it exposes are derived
  deterministically from the date anyway, which is what makes confirmed defect 1 possible.
- `src/persist.js` — corrupt-storage harness: `loadSave` and `loadSnapshot` were called against a fake
  `localStorage` pre-filled with `{`, `null`, `[]`, `{"v":9999}`, `"a"`, `0`, `undefined`, `{"v":1}`,
  `{"v":1,"data":null,"crc":0}` and `{"data":{"progress":null}}`. Neither threw.

## Not tested

- The browser UI: `tests/e2e.smoke.mjs` is HTTP/engine-level only, and there is no headless-browser suite.
  Rendering, input, accessibility and responsive layout were not exercised.
- Audio output (`src/audio.js`).
- SSE/live features — this game has none.

## Runtime artefacts

Starting `server.js` and running the shipped `tests/e2e.smoke.mjs` created an untracked `data/` directory
(the leaderboard store) inside this game folder. It is runtime state, not a source change; it is being
cleaned up centrally. The three exploits above were run against a **copy** of the game in a scratch
directory, so no forged entry was written to this folder's boards — only the shipped smoke test's
`smoke-tester` submission is present here.
