# Discovery Merge — Game Design Document (running spec)

This document describes Discovery Merge as it ships today. Present tense throughout; anything the design wants but the code does not yet do is collected under "Design intent not yet implemented" at the end.

## 1. Overview

**Pitch:** tap brass Field Kits to produce curiosities, merge identical ones up a six-tier discovery chain, and hand the right tier to the cabinet keeper's request cards — every finished board restores a little more of an explorer's cabinet diorama.

| | |
|---|---|
| Genre | Solo merge/discovery puzzle with request goals |
| Players | 1; asynchronous daily leaderboard |
| Session length | Journey stage 1–4 min; Daily 5–10 min; Learn lesson under a minute |
| Platforms | Desktop and mobile browsers (portrait and landscape); WebGL2/WebGL with a full 2D DOM fallback |
| Rendering | Three.js r160 (vendored) tabletop diorama; semantic HTML for all menus, HUD, overlays and an always-present keyboard/screen-reader board mirror |
| Backend | Optional `server.js` (Node ≥ 18, zero dependencies): static hosting plus same-origin `/api/v1/*`; fully playable offline |

### File map

| Path | Responsibility |
|---|---|
| `index.html` | Shell: topbar, six `<section class="screen">` panels, mobile tray, overlay/toast/live-region roots |
| `css/style.css` | Palette tokens, responsive layout, DOM board, overlays, accessibility modes |
| `src/main.js` | Boot, screen router, mode setup, HUD, pause/resume/snapshot, results, achievements, settings, gamepad loop, `?selftest=1` harness |
| `src/engine/rules.js` | Pure deterministic rules: `createGame`, `legalActions`, `applyCommand`, scoring, terminal checks, `replay` |
| `src/engine/rng.js` | mulberry32 stream, FNV hashes, `stableStringify` |
| `src/content.js` | Chains, five themes, 40 journey stages, daily/practice/challenge generators, four lessons, `validateLevel` |
| `src/session.js` | `GameSession`: command log, undo stack, elapsed clock, replay envelope, snapshots |
| `src/render.js` | `BoardRenderer`: board, item meshes, diorama props, particles, camera, quality tiers |
| `src/ui.js` | `DomBoard` (2D board + a11y mirror), `PlayController` (pointer, drag, keys, tutorial gating), modal/toast/announce |
| `src/audio.js` | `AudioEngine`: three buses, sample one-shots with synth fallbacks, seeded music and ambience |
| `src/platform.js` | `/api` adapter: fragment launch token + Bearer + 45-min refresh, server time, daily board (its-backend), profile nickname, cloud-save slot (zip+base64, debounced); offline fallbacks |
| `src/persist.js` | Checksummed save, board snapshot, guest id, `ACHIEVEMENTS`, `DEFAULT_SETTINGS` |
| `server.js` | Authoritative script declared in `starhermit.txt`: replay-validated daily board |
| `sfx/` | 15 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` |
| `assets/` | `key-art.webp`, `cabinet-restored.webp`, `cabinet-locked.webp` |
| `tests/` | `rules.test.mjs` (node --test), `e2e.mjs` (Playwright UI playthrough), `e2e.smoke.mjs` (server validation) |
| `coverart.png`, `icon.png`, `favicon.svg`, `starhermit.txt`, `LICENSE.md` | Distribution metadata |

## 2. Vision and design pillars

Discovery Merge is a quiet cabinet-keeper fantasy: a lamp-lit desk, a felt-lined tray, and the small joy of turning two pebbles into a fossil. The pillars below decide every rule and effect in the game.

1. **Every tap is a discovery, never a chore.** Generators are infinite and free; the only cost of a tap is board space and one action. Rules in: unlimited Field Kit charges in every authored level, tier-0 discovery points on the very first spawn. Rules out: energy, cooldowns, timers that stop play, paid boosts.
2. **The board is the only truth.** Anything that matters is visible on the tray: crates, cobwebs, tier pips on every piece, the selected piece's legal merge targets outlined in green. Rules in: `legalActions()` drives hints, tutorials and the deliver buttons alike. Rules out: hidden modifiers, off-board inventory, random surprise effects.
3. **Requests give merging a destination.** The win condition is fulfilling request cards, not reaching a top tier; the score rewards the finished card far more than the merge. Rules in: 150-point completion bonus, "Deliver" as a first-class action with drag-to-card. Rules out: infinite score chase inside a board, merging for its own sake.
4. **Fair, replayable, inspectable.** Every level is a seed plus visible parameters; every round is an ordered command log that the server re-simulates. Rules in: seeds printed on the setup and results screens, deterministic ids, exact hash matching. Rules out: client-declared scores, hidden difficulty scaling, undo in ranked modes.
5. **A cabinet you can operate blind.** The Three.js tray is a presentation of a semantic grid that stays keyboard- and screen-reader-operable at all times. Rules in: the DOM board mirror, per-cell `aria-label`s, live-region announcements for every event. Rules out: canvas-only controls, hover-only information, audio-only cues.

## 3. Player experience

**Target player:** someone who likes tidy, low-stress puzzle sessions (merge games, sorting games) and enjoys collecting; comfortable on a phone, happy on a desktop.

**First 60 seconds.** The title screen shows the key art, one big Play button and three cards (Daily Cabinet, Journey, Curator Profile). Play opens the mode grid where Learn is first. Learn runs four lessons that each introduce one rule and gate input until the player performs it (`PlayController._tutorialAllows`): 1 tap the Field Kit, 2 merge a pair, 3 deliver to a request, 4 clear a cobweb. Each step is spoken in the objectives rail and the live region; any other action plays the invalid cue and repeats the step text. Journey stage 1 ("First Shelf") is a 5×5 board with one chain and two tier-1 requests, so a player who skips Learn still meets only tap, merge and deliver. Every setup screen states board size, mechanics in play, request count, expected minutes, seed, move limit if any and whether the round is ranked before the player commits.

**Session shape.** Setup → 3-beat Ready/Set/Go countdown (skipped under reduced motion) → play until every request card is complete or the board locks → results with a component breakdown, achievements and Next stage / Retry / Home. Journey stages unlock sequentially; completed ones stay replayable for a better score.

**Emotional beat.** The "request complete" stamp: a card that has been sitting in the rail flips to done, the stamp-and-bell cue plays, and the board suddenly has room again. Winning layers the brass fanfare, a particle burst and the "Cabinet restored!" illustration on top of that.

## 4. Core loop and rules contract

All rules live in `src/engine/rules.js`; nothing else mutates state. `applyCommand(state, cmd)` returns `{ ok, state, events }` or `{ ok:false, error, events:[{type:'invalid', reason}] }` and never throws or mutates its input.

### Board and entities (`createGame`)

- Grid of `cols × rows` cells (5×5 to 7×7), indexed row-major; cell `i` is row `floor(i/cols)`, column `i % cols`.
- **Generator** ("Field Kit"): `{ kind:'generator', chain, spawn:[[tier, weight]], charges }`. All authored levels use `charges:-1` (infinite) and the default spawn table `[[0,1]]`, so a tap always produces tier 0.
- **Piece**: `{ kind:'piece', chain, tier, webbed }`. Four chains × six tiers (`CHAINS` in `content.js`): Expedition Tools, Sunken Relics, Verdant Specimens, Curious Oddities.
- **Crate**: permanent blocker; never moves, never merges.
- **Cobweb**: a `webbed` piece cannot move, be delivered, or be the source of a merge; merging a matching free piece onto it produces the next tier unwebbed (`applyMerge`, `unwebbed:true` in the event).
- **Requests**: `{ id, needs:[{chain, tier, count}], progress:[], done }`.

### Legal actions (`legalActions`)

Returns `{ taps, merges, delivers, movesCount, canAct }`. Taps need a generator with charges and at least one free cell. Merges need two pieces of the same chain and tier below the chain's max tier, not both webbed; the non-webbed one is the source. Delivers need an unwebbed piece matching an unmet need. Moves: any unwebbed piece to any free cell. Hints, tutorials, the e2e solver and the server all use this same function.

### Commands and resolution order (`applyCommand`)

Shape check → status must be `active` → move limit not exhausted → per-command validation → clone state, `tick += 1` → mutate → score → `movesUsed += 1` → `checkTerminal`.

| Command | Validation (reason on failure) | Effect |
|---|---|---|
| `tap {cell}` | in bounds, is generator (`not-generator`), charges (`no-charges`), free cell exists (`board-full`) | Roll tier from spawn table via the rules RNG, pick a uniformly random free cell via the RNG, place a new piece; `spawn` then possibly `discover` events |
| `merge {from,to}` | bounds, `same-cell`, source is piece (`no-piece`), target is piece (`target-empty`), source not webbed (`webbed`), same chain and tier (`mismatch`), below max (`max-tier`) | Target becomes tier+1 (unwebbed), source cleared; `merge` then possibly `discover` |
| `move {from,to}` | bounds, `same-cell`, piece at source, not webbed, target empty (`target-occupied`) | Relocate; `move` event |
| `deliver {cell,request}` | piece exists, not webbed, request open (`bad-request`), matches an unmet need (`no-matching-need`) | Increment that need's progress, remove the piece; `deliver` and possibly `request-complete` |

Rejected commands do not enter the log; `GameSession.dispatch` calls `noteInvalid` so `stats.invalid` increments (the tie-break stat).

### Scoring (`state.score` components, all integers)

| Component | Rule | Owner |
|---|---|---|
| merge | `10 × resulting tier` | `applyMerge` |
| discovery | `25 × (tier+1)` the first time this round a chain reaches that tier (initial pieces count silently) | `noteDiscovery` |
| request | `5 × (tier+1)` per delivered piece, plus `150 + Σ 20 × tier × count` when a card completes | `applyDeliver` |
| bonus | `5 × unused actions` on a win when a move limit exists | `checkTerminal` |
| time bonus | `min(500, 2 × (par − elapsed))` if under par on a win; results only, not in the replay hash | `timeBonus`, `GameSession.results` |

`totalScore = merge + discovery + request + bonus + penalty` (penalty is always 0 today).

**Worked example (Journey stage 1, as played by the e2e test):** two requests each need one Surveyor's Pick (tools tier 1). Tap ×2 → first tier-0 spawn discovers tier 0 (+25). Merge → tier 1: +10 merge, +50 discovery. Deliver: +10, card completes: +150 + 20×1×1 = +170. Repeat tap, tap, merge, deliver for the second card: +10 merge (no new discovery), +180 request. Components: Merges 20, Discoveries 75, Requests 360 = 455 after 8 actions; finishing in 5 s against a 26 s par adds a 42-point time bonus → 497.

### Terminal states (`checkTerminal`, run after every accepted command)

1. All requests done → `won`, reason `requests-complete` (move-limit bonus applied here).
2. `moveLimit` reached → `lost`, `out-of-moves`.
3. `legalActions().canAct === false` → `lost`, `no-legal-moves` (a full board with no merge or delivery available).
Lessons 1 and 2 have no requests and end when the player presses Finish lesson (`finishLevel(true)` marks them won with reason `lesson-complete`).

### Tie-breaks (server `rankEntries`)

Score desc → fewer invalid actions → lower server-derived elapsed seconds → stable entry id.

### RNG and seeding

`createRng(seed)` is mulberry32 (`rng.js`); the rules stream is part of the serialized state so replays are bit-exact. Level layout uses a separate stream seeded `seed ^ 0x9e3779b9` (`content.js derive`). Journey seeds are `hashString("journey:<index>")`, dailies `hashString("daily:YYYY-MM-DD")`, challenges `hashString("challenge:<name>")`, practice `hashString("practice:" + Date.now() + ":" + Math.random())`. Item ids are `seed:t<tick>` / `seed:init:<cell>` / `seed:gen:<cell>` so hashes are stable across processes.

### Undo and hints

Undo (`GameSession.undo`) pops a serialized pre-command state; allowed only when `allowUndo` (Practice and Learn), never enters the log, capped at 200 entries. Hint (`GameSession.hint`) priority: first legal delivery → highest-tier merge → first tap; shown for 2.6 s as a ring in 3D and a dashed outline in 2D, announced as text, with the `hint` cue.

## 5. Modes and progression

| Mode | Content | Undo | Ranked | Board |
|---|---|---|---|---|
| Learn | 4 authored lessons (`tutorialLevels`), 4×4/5×5, tools chain only | yes | no | atelier |
| Journey | 40 stages (`journeyLevel(i)`), 8 per theme, stage 8 of each wing is a mastery stage with a move limit | no | yes (local best per stage) | theme by wing |
| Daily | `dailyLevel(date)`: one seed per UTC day from platform time | no | yes; first win submits | random theme |
| Practice | easy / medium / hard (`PRACTICE_DIFFICULTIES`), fresh seed each time | yes | no | theme by hash of difficulty |
| Challenge | Frugal Hands (move limit 1.3× minimum), Brisk Catalog (par-clock chase, observatory), Crowded Shelves (5×5, 6 crates, 3 cobweb pairs, ember) | no | flagged ranked; local only | fixed |
| Score Chase | Today's daily board (server or casual local), copy a `?seed=YYYY-MM-DD` share link | — | — | — |

**Journey curve** (all from `journeyLevel`): board 5×5 for stages 1–8, 6×6 for 9–24, 7×7 for 25–40. Chains 1 (stages 1–6), 2 (7–14), 3 (15+), ordered per theme so each wing leads with a different chain. Crates from stage 6, rising to 6 by stage 33. Cobweb pairs from stage 7, up to 4 by stage 28. Request tiers 1–2 early, minimum tier 2 from stage 15, maximum tier 5 from stage 25 (mastery stages add +1 earlier). Two-need requests from stage 21, double counts from stage 29. Mastery stages get one extra request and `moveLimit = ceil(1.45 × minimum actions)`. Par seconds are always `ceil(3.2 × minimum actions)` where a tier-t piece costs `2^(t+1) − 1` actions plus one delivery (`minActionsForNeeds`).

**Daily**: 6–7 cells square, 3 of the 4 chains, 2–4 crates, 1–3 cobweb pairs, 4 requests of 1–2 needs up to tier 3–4. Server time (`/api/v1/time`) decides the day; the setup screen counts down to the next seed. A day's first win is stored in `save.dailies[date]` and submitted; later wins update the local best only.

**Unlocks**: journey stages unlock strictly in order; the diorama's eight pedestal props appear at `round(8 × completed/40)`. The Codex modal shows the highest tier ever created per chain (`save.codex`). Six achievements (`persist.js ACHIEVEMENTS`): First Restoration, Deep Discovery (tier-5 item), Web Clearer (10 cobwebs), Steady Hands (3 daily days), Mastery Archivist (all 5 mastery stages), Grand Curator (all 40).

## 6. Controls and interaction

| Input | Desktop | Mobile |
|---|---|---|
| Tap generator | click / Enter on cell | tap |
| Select piece | click / Enter | tap |
| Merge | select then click twin, or drag onto twin (3D canvas, >12 px) | tap then tap, or drag |
| Move | select then click empty cell, or drag | same |
| Deliver | select then press the card's "Deliver selected piece" button, or drag onto the card | open Requests drawer then press the button, or drag onto the card |
| Deselect | click selected cell again, or Esc | tap again |
| Pause | Esc (nothing selected), Pause button, gamepad Start | tray Pause |
| Undo / Hint / Camera | U / H / C or rail buttons | tray Undo / Hint |
| Grid navigation | arrows on the DOM board (`DomBoard` keydown), gamepad d-pad/stick | — |

Gamepad (`startGamepadLoop`): d-pad or left stick moves focus, A confirms, B cancels the selection, Start pauses.

**Input locking**: after any accepted command `PlayController.inputLocked` is true for 260 ms (the non-interruptible resolution phase); the round ends 700 ms after a terminal event. Pointer capture is taken on `pointerdown`; `pointercancel`/`lostpointercapture` abandon the drag safely. Duplicate command ids are rejected idempotently in `GameSession.dispatch`.

**Feedback for every input**: tap → `tap` cue and spawn pop; select → `select` cue, gold ring (3D) / outline (2D), live-region text listing what can be done; legal merge targets outlined green in the DOM board; drag target ring in 3D; invalid → `invalid` cue, cell shake in 3D, assertive announcement from `INVALID_TEXT`; crates announce "A crate blocks that cell."

## 7. Screens and UI flow

`boot → title ⇄ modes ⇄ {journey | setup} → play ⇄ pause modal → results → (title | next stage | retry)`. `showScreen()` in `main.js` hides all other sections, focuses the first heading or button and announces the screen name. Modals (`openModal`) trap Tab, close on Esc, and restore focus. Visibility change pauses the session and stores a snapshot; a "Resume paused board" button appears on the title while a snapshot exists.

- **Title**: key art (`assets/key-art.webp`, falls back to emoji glyphs on load error), tagline, Play, three cards, resume note. Topbar: Help, Codex, Settings; status text shows "Connected to host" or "Offline mode — fully playable".
- **Modes**: six cards with one-line rule summaries and ranked flags.
- **Journey**: five theme groups of eight stage buttons; locked stages disabled with `aria-label` stating locked/mastery/best score.
- **Setup**: level name, rules summary, estimated minutes, player count, seed, move limit, Ranked/Unranked badge, Start. Also hosts the Learn, Practice, Challenge lists and Score Chase table.
- **Play** (desktop ≥1024 px): left rail Requests + lesson panel (15–19 rem), centre board region, right rail Score / Actions / Timer / Pause / Undo / Hint / Reset camera (13–16 rem). Below 1024 px both rails become slide-in drawers over the board and the bottom `#mobile-tray` (Pause, Undo, Hint, Requests, Score) appears; tapping the board closes drawers. Landscape phones (height ≤520 px) shrink the topbar to 40 px. Safe-area insets pad the topbar, tray and toasts.
- **Results**: headline (won/lost), illustration (`cabinet-restored.webp` / `cabinet-locked.webp`), breakdown table, actions/invalid/elapsed/par/seed line, achievement lines, Retry / Next stage / Home.

Must never be cut off: the Play button, the deliver buttons on request cards, the mobile tray, the countdown, and the results total row. The play screen is `overflow:hidden`; every other screen scrolls vertically.

## 8. Art direction

**Hero**: the tray. The camera (`_frameCamera`) is an authored 38° perspective from the front-top, distance `span × 1.18` (landscape) or `× 1.5` (portrait), with an optional "top" tilt; the board is centred and rails never overlap it on desktop.

**Palette** (CSS tokens): background `#171310`, panel `#241d17`, panel-2 `#2e251d`, ink `#f2e9da`, ink-dim `#c4b6a2`, accent amber `#e0a458`, accent-2 sky `#8ecfff`, ok `#9fe08a`, danger `#ff7a6b`. Chains: tools `#c98f3d`, relics `#8d6bc9`, flora `#4d9e5f`, curios `#3d8fc9`. Themes (`THEMES`): Atelier of Dawn (sky `#2a2018`, key `#ffd9a0`, board `#8a6b4a`), Verdant Conservatory (`#16251c`, `#d8ffd2`, `#4f6b4a`), Midnight Observatory (`#0e1226`, `#aec4ff`, `#39406b`), Tidepool Grotto (`#0f2226`, `#a8f0e6`, `#3d6b6b`), Ember Archive (`#241317`, `#ffb08a`, `#6b4438`). High-contrast mode swaps to black panels, white ink, `#ffd24d` / `#66c2ff` accents.

**Shape language**: rounded felt cells in alternating tones on a walnut base; pieces are low rounded slabs carrying a chain-coloured label tile with the tier glyph and 1–6 pips; generators are brass-ringed cylinders with a slowly spinning torus; crates are dark banded boxes; cobwebs a translucent radial web decal. Selection is a gold ground ring, drag target green, hint blue and pulsing. Key art and illustrations are painterly lamp-lit miniatures in the same amber/walnut/cream palette.

**Typography**: Iowan Old Style / Palatino / Georgia serif stack at 16 px root (20 px in large-text mode); headings weight 700; max line length 70ch on prose.

**Motion**: spawn scale-in 0.28 s, merge pulse 0.22 s, move slide 0.25 s ease-in-out, camera reframe 0.6 s, win/lose camera pulse 0.5 s, particle bursts of 40 from a 240-point pool. Reduced motion (setting or `prefers-reduced-motion`) snaps every tween to its end state, disables shakes, pulses, ring spin and bursts except the win burst, skips the countdown, and collapses CSS transitions to 1 ms.

**Visual assets the design calls for**: title key art, win illustration, lock-up illustration, cover art, favicon/icon — all shipped (see §15). Board geometry stays procedural by design; no external models.

## 9. Audio direction

Everything is short, wooden, brass and glass — cabinet sounds, not arcade sounds. `AudioEngine` has a master gain and three buses: music (setting × 0.5), effects (setting), ambience (setting × 0.35); Mute zeroes the master, and a hidden tab mutes without tearing down the graph. Audio unlocks on the first pointer/key gesture. Music is a seeded minor-pentatonic sine arpeggio (root 196 Hz, one note every 620 ms); ambience is a seeded noise loop low-passed at 320 Hz. Every effect first tries its Opus sample (fetched lazily after unlock, cached) and otherwise plays a synthesized fallback with a seeded pitch variant, so the cue is never missing.

### SFX event table (source of `sfx/manifest.txt`)

| Event id | File | Sound | Usage |
|---|---|---|---|
| tap | ui-tap.opus | crisp single wooden knock | tapping a Field Kit; tapping an empty cell with nothing selected |
| select | ui-select.opus | soft brass latch click | piece selected/deselected |
| spawn | item-spawn.opus | cork pop with airy fizz | rules `spawn` event |
| move | item-move.opus | wooden piece sliding on felt | rules `move` event |
| invalid | move-invalid.opus | dull double thud on a hollow box | any rejected command, tutorial-gated action, unavailable undo |
| merge | merge-success.opus | marble clink into a rising chime | rules `merge` event |
| discover | discovery-sparkle.opus | tiny bells over a harp glissando | rules `discover` event |
| deliver | deliver-parcel.opus | parcel slide, thump, stamp | rules `deliver` event |
| requestComplete | request-complete.opus | ink seal stamp and bell ding | rules `request-complete` event |
| win | win-fanfare.opus | small warm brass fanfare | rules `win` event |
| lose | lose-sting.opus | descending marimba, music box winding down | rules `lost` event |
| undo | undo-whoosh.opus | reversed page-flip whoosh | undo performed |
| hint | hint-glimmer.opus | two-note glass glimmer with a compass tick | hint shown |
| webClear | web-clear.opus | cobweb tearing with a dusty puff | merge onto a cobwebbed twin (layered under merge) |
| achievement | achievement-medal.opus | medal set on velvet, one ceremonial bell | results screen lists a new achievement |

## 10. Localization

Required locales for this product family: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT. **Today only en-US ships.** All strings are inline in `index.html`, `src/main.js`, `src/ui.js` (`INVALID_TEXT`) and `src/content.js` (chain, tier, level and lesson names); `<html lang="en">` is fixed and there is no language selector or locale detection. Layout allowances that already exist: cards wrap, the setup summary is capped at 70ch, buttons have `min-height:44px` and wrap, and the mobile topbar wraps its status line — enough for ~30% string expansion. See "Design intent not yet implemented".

## 11. Accessibility

- **Keyboard-only path**: title → Play → mode card → setup → Start → arrow keys across the DOM board (visible when "Use 2D board" is on, otherwise a visually hidden but focusable mirror whose focus rings the matching cell in 3D) → Enter to tap/select → Tab to a request card's Deliver button → results buttons. Esc closes modals or pauses.
- **Focus**: `:focus-visible` 3 px sky outline; modals trap focus and restore it on close; `showScreen` moves focus to the new screen's heading.
- **Announcements**: polite live region for screen changes, selections, discoveries, request completion, hints; assertive for invalid actions, pause, results headline and total.
- **Cell descriptions**: `DomBoard.describeCell` names the item, tier, cobweb state and row/column.
- **Contrast and colour**: ink on panel exceeds 10:1; chain colour is reinforced by glyph and tier pips, plus a chain-letter badge in colour-vision-safe mode; high-contrast mode available.
- **Reduced motion, larger text, 2D board, camera tilt, independent music/effects/ambience sliders, mute** — all in Settings and persisted.
- **Targets**: every button ≥44×44 CSS px; DOM cells 2.6–4.2 rem; tray buttons spaced 8 px in landscape.
- **Captions**: every audio cue has a visible or announced counterpart (spawn animation, merge pulse, request card state, results text).

## 12. StarHermit integration

Per https://wiki.starhermit.com/ conventions the distribution root carries `starhermit.txt` (`name=Discovery Merge`, `launch=index.html`, `owner=…`, `server=server.js`, `version=1.0.0`, `cover=coverart.png`).

Used:
- **Authoritative game script** (`server.js`): `GET /api/v1/time`, `GET/POST /api/v1/leaderboard/daily`, `POST /api/v1/presence`, `/activity/start|end`, `/telemetry`. Daily submissions must be for the current UTC day, carry matching rules/content versions and the daily seed, replay to a win through the real engine, and match the claimed total and final hash exactly; elapsed seconds are server-derived. Board rows persist in `data/leaderboard.json`.
- **Server time** for daily boundaries with round-trip offset (`Platform.syncTime`).
- **Launch token**: read from the URL fragment `#game_token=<jwt>` (optional `&session_id=`, stripped after the read; `?token=` kept for local dev), decoded for `sub` + `game_scope` (never hard-coded), sent as a Bearer header on every call, re-minted every 45 min via `POST /api/v1/games/{slug}/launch-token` (60 s retry), never stored. The old `<uuid>.starhermit.com` force-offline is gone — hosted mode activates whenever a token exists.
- **Identity**: hosted display name is the profile nickname from `GET /api/v1/users/{sub}/profile` (never usernames, never `/api/v1/me`; `Player <id8>` fallback), shown in the Curator Profile line and on daily submissions/board rows; the top bar shows "Playing as <nickname> · sync status". **Cloud save**: the checksummed save document mirrors to one zip+base64 slot at `GET/PUT /api/v1/me/cloud-saves/{slug}` — remote wins on boot (validated by `parseSave`), saves debounce 2 s and flush on `pagehide`/hidden with keepalive.
- **Presence heartbeat / activity / telemetry**: own-server sinks exist for local dev only — hosted mode stays silent (no launch-token endpoints, wiki).

Not used: platform achievements (local), friends filtering, realtime sessions, rooms, chat, voice. Standalone keeps the local `guest-…` id as the board name.

## 13. Technical architecture

- **Rules** are pure and node-safe; `session` is the only writer of rules state; `render` and `ui` consume snapshots and event lists. UI state (selection, drawers, modals) never touches simulation state.
- **Determinism/replay**: `replayEnvelope()` = schema 1, rules and content versions, level id, seed, initial hash, ordered commands, per-command hashes, result. `replay(level, commands)` in `rules.js` rebuilds any round; the server and the smoke test rely on it.
- **Persistence** (`localStorage`): `discovery-merge.save.v1` (FNV-checksummed document: settings, journey bests, dailies, streak days, codex, achievements, stats, casual board), `discovery-merge.snapshot.v1` (paused board, written every second and on pagehide/visibility change), `discovery-merge.guest.v1`.
- **Rendering**: one `WebGLRenderer` with ACES tone mapping, sRGB output, a key directional light with a 1024² shadow map and a hemisphere fill. Quality tiers: low (DPR 1, no shadows, no particles, no AA), medium (DPR 1.5), high (DPR 2); `auto` samples FPS every 2 s and drops below 28 fps / rises above 48 fps. Geometries are shared and disposed on `dispose()`; the renderer stops entirely while the tab is hidden.
- **Budgets**: on a full 7×7 board, 49 cell meshes + up to ~100 item meshes (a piece is body + label, a generator adds a ring) + base, wall, ground and 16 prop meshes ≈ 170–200 draw calls worst case, one 240-point particle cloud; no per-frame allocations beyond tween bookkeeping. If WebGL init fails the game switches to the 2D DOM board with a toast and keeps playing.
- **Server**: static files with `no-cache`, refuses `/data/`, `server.js`, `spec.md`, path traversal and malformed encodings (400); 256 KB body cap; command logs capped at 20 000.
- **E2E**: `tests/e2e.mjs` serves the repo from an embedded static server, launches system Chrome via `playwright-core`, enables the 2D board and reduced motion through the real Settings modal, then plays Journey stage 1 to a win on desktop 1280×800 and mobile 390×844 by reading cell `aria-label`s and clicking real cells, deliver buttons, hint, pause and resume.

## 14. Testing and acceptance criteria

`npm test` (`node --test tests/*.test.mjs`, 27 tests): spawn determinism, charges, merge/mismatch/max-tier, cobweb rules, move rules, delivery and win, move-limit loss, no-legal-moves loss, serialization round trip, replay hash stability, seed divergence, immutability, component scoring, time bonus cap, malformed-command fuzz, `validateLevel` on all 40 journey stages, a sweep of dailies, practice, challenges and lessons, a golden-hash session, and greedy-solver winnability of every journey stage and sampled dailies.

`tests/e2e.mjs` asserts: boot without page or console errors, title hidden when other screens show, 40 stage buttons with exactly one unlocked, setup → play with the 2D board visible, hint and pause/resume, a "Cabinet restored!" result with breakdown rows and a Next stage button, journey progress persisted, and the Score Chase table highlighting only the current guest.

`tests/e2e.smoke.mjs` (against a running `server.js`): a solver-produced daily envelope is accepted and ranked; the same envelope with an inflated total is rejected with `score-mismatch`.

QA bar as checkable statements: a new player is taught by Learn lessons or by the stage-1 rules summary before any unfamiliar mechanic appears; every feature (six modes, undo, hint, camera reset, settings, codex, profile, share link) is reachable by clicking visible UI; no console errors or warnings on desktop or mobile viewports (the only permitted 404s are `/api/*` when offline); no text or control is clipped at 1280×800, 390×844 or 844×390.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200×672, 68 KB) | Title-screen hero | FLUX.2 klein, seed 2020, 28 steps | generated in this pass, wired |
| `assets/cabinet-restored.webp` (640×400, 26 KB) | Results illustration on a win | FLUX.2 klein, seed 2021 | generated in this pass, wired |
| `assets/cabinet-locked.webp` (640×400, 24 KB) | Results illustration on a loss | FLUX.2 klein, seed 2022 | generated in this pass, wired |
| `coverart.png` (1200×675, 356 KB) | Platform cover | key art scaled and palettised | replaced in this pass (previous file was a generic placeholder) |
| `icon.png`, `favicon.svg` | Platform icon, tab icon (magnifier glyph) | authored SVG | shipped |
| `sfx/*.opus` × 12 (tap … undo) | Core cues, see §9 | MOSS-SoundEffect v2.0 | shipped |
| `sfx/hint-glimmer.opus`, `sfx/web-clear.opus`, `sfx/achievement-medal.opus` | hint, webClear, achievement cues | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` | Canonical clip → event → description → usage list | hand-written | added in this pass |
| Board, pieces, generators, crates, cobwebs, diorama props | In-game 3D | procedural (`render.js`), canvas-drawn label textures | shipped |
| 3D models / character animation | — | not called for (no hero prop, no humanoid) | n/a |

## 16. Known limitations

- The daily board identifies players by display name only; without a host-verified identity a client could submit under another name (server accepts any `name`).
- `legalActions` lists one direction per mergeable pair (lower cell → higher cell) so hints never suggest merging onto the lower cell, although `applyMerge` accepts either direction when the player chooses it.
- Stage 5 lists "crates block cells" in its rules summary but its crate count is 0; crates first appear on stage 6.
- "Brisk Catalog" differs from a standard 6×6 board only by theme; its speed target is the ordinary par-clock time bonus.
- A `?seed=YYYY-MM-DD` shared board is started in daily mode: a win records itself as today's daily completion locally and its submission is rejected by the server (`seed-mismatch`), falling back to the casual board.
- Practice seeds come from `Date.now()`/`Math.random()` and cannot be shared or replayed after the round.
- Settings "Left-handed layout", "Haptics" and "Hints enabled" are stored but have no effect; the "Camera" select only offers default/top.
- Challenge and journey results are ranked locally only; no server board exists for them.
- Music and ambience are synthesized; there are no authored music stems.
- Only English ships (see §10).

## Design intent not yet implemented

- Nine-locale string table with runtime language selection (host preference → `navigator.language` → en-US) and per-locale number/time formatting.
- Friends filter on the daily board; platform achievement unlocks mirroring the six local ones (identity, board names and cloud save are done).
- Enumerating both merge directions in `legalActions` so hints can free the more useful cell.
- Distinct "speed" rules for Brisk Catalog (tighter par, visible countdown) and a real left-handed tray order.
- Haptic pulses on merge and request completion where `navigator.vibrate` exists, gated by the existing Haptics setting.
