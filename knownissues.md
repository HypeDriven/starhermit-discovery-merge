# Known Issues — Discovery Merge

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and end-to-end smoke.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node --test test/*.test.mjs`) | 27/27 pass, 0 fail |
| `node --check` on all modules | clean (`src/**/*.js`, `server.js`, `test/*.mjs`) |
| `test/e2e.smoke.mjs` (against `PORT=39310 node server.js`) | PASS — valid submission ranked, tampered score rejected with `score-mismatch`, board readback correct |
| HTTP fuzz of `server.js` (directories, traversal, malformed encodings, 20 malformed bodies + odd query strings on all 6 API routes) | survived; no crash, no traversal |

## Confirmed defects

All three were reproduced against a running copy of `server.js`.

### 1. Any future daily board can be pre-solved and pre-populated

- **File:** `server.js:124-169` (`POST /api/v1/leaderboard/daily`), specifically the date handling at
  lines 130 and 143
- **Trigger:** submit a valid replay with `date: "2027-06-01"`.
- **Behaviour:** the only date check is the shape test `/^\d{4}-\d{2}-\d{2}$/`. `dailyLevel(date)` then
  deterministically produces that day's level, which the client can equally well generate offline right
  now. The replay validates honestly against it and the entry is stored under `boards["2027-06-01"]`.
  There is no comparison against the server's current UTC day and no submission window.
- **Expected:** spec.md §2 "Modes" — "Daily: one shared seed and ruleset per UTC day, synchronized to
  platform time"; §2 also states daily seeds are immutable after publication, which presumes publication
  is a point in time.
- **Evidence:**

  ```
  date=2027-06-01 status=won score=3435 moves=181
  SUBMIT 200 {"ok":true,"rank":1,"entries":1}
  GET /api/v1/leaderboard/daily?date=2027-06-01
    {"date":"2027-06-01","entries":[{"rank":1,"name":"preSolver","score":3435,"seconds":1,"validated":true}]}
  ```

### 2. Elapsed time is client-declared and decides ties

- **File:** `server.js:157` (`seconds: Math.max(0, Math.min(86400, claimed.elapsedSeconds | 0))`) with the
  comparator at `server.js:65-71`
- **Trigger:** submit an honest replay with `result.elapsedSeconds: 0`.
- **Behaviour:** the server clamps the value to 0..86400 but otherwise takes the client's word for it; it
  never derives elapsed time from its own clock or from the replay. `rankEntries` uses
  `a.seconds - b.seconds` as the third key, after score and invalid actions, so a zero-second claim wins
  every tie.
- **Expected:** spec.md §2 "Scoring and victory" — ties use "lower **authoritative** elapsed time". The
  server does expose `/api/v1/time` but never cross-checks the claim.
- **Evidence:** two byte-identical solves of the same daily, differing only in the declared time:

  ```
  honest   score=5355 seconds=900 -> rank 2
  impostor score=5355 seconds=0   -> rank 1
  ```

### 3. `x-player-id` is unauthenticated, so one client can overwrite another player's board entry

- **File:** `server.js:152` (`const playerId = req.headers['x-player-id'] || name;`) with the
  replace-if-better logic at `server.js:160-166`
- **Trigger:** send a valid submission with `x-player-id` set to another player's id (which, by the same
  line, defaults to their display name and is therefore visible on the public board).
- **Behaviour:** the header is trusted verbatim. `boards[date].findIndex((e) => e.id === entry.id)` then
  matches the victim's row, and if the incoming entry ranks better it *replaces* it — the victim's name,
  score and time are gone, not merely outranked.
- **Expected:** spec.md §6 "Identity, profile, presence, and preferences" — board identity comes from the
  host's verified identity, not from a client-settable header used as the primary key.
- **Evidence:** after an entry named `honest` (id `honest`) was on the board, a second submission sent
  with `x-player-id: honest` and `name: impostor` replaced it:

  ```
  before: [{"name":"smoke-tester","seconds":300},{"name":"honest","seconds":900}]
  after : [{"rank":1,"name":"impostor","seconds":0},{"rank":2,"name":"smoke-tester","seconds":300}]
  ```

  The `honest` row is gone.

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

- The browser UI: `test/e2e.smoke.mjs` is HTTP/engine-level only, and there is no headless-browser suite.
  Rendering, input, accessibility and responsive layout were not exercised.
- Audio output (`src/audio.js`).
- SSE/live features — this game has none.

## Runtime artefacts

Starting `server.js` and running the shipped `test/e2e.smoke.mjs` created an untracked `data/` directory
(the leaderboard store) inside this game folder. It is runtime state, not a source change; it is being
cleaned up centrally. The three exploits above were run against a **copy** of the game in a scratch
directory, so no forged entry was written to this folder's boards — only the shipped smoke test's
`smoke-tester` submission is present here.
