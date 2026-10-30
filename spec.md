# Discovery Merge — Game Design Document (running spec)

This document describes Discovery Merge as it ships today. Present tense throughout; anything the design wants but the code does not yet do is collected under "Design intent not yet implemented" at the end.

## 1. Overview

**Pitch:** tap brass Field Kits to produce curiosities, merge identical ones up a six-tier discovery chain, and hand the right tier to the cabinet keeper's request cards — every finished board restores a little more of an explorer's cabinet diorama.

| | |
|---|---|
| Genre | Solo merge/discovery puzzle with request goals |
| Players | 1; per-device daily board |
| Session length | Journey stage 1–4 min; Daily 5–10 min; Learn lesson under a minute |
| Platforms | StarHermit engine 1.30.0 script game: natively in the StarHermit client, and in desktop and mobile browsers (portrait and landscape) by the engine's web runtime; a full 2D board option |
| Rendering | `starhermit:scene` tabletop diorama (three.js-like); `starhermit:ui` immediate-mode menus, HUD and dialogs, with every cell an accessibility target |
| Backend | `score-script.js` (platform game script) posts ranked totals to the `high-score` board; fully playable as a guest and offline |

### File map

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.30.0`, `engine.minor=32`, capabilities `platform,storage,clipboard`, `server=score-script.js`, the `control.*` keys and `engine.gamepad.*` buttons |
| `index.html`, `starhermit-files.json` | The engine's web loader and the package's file index, written by `npm run package` (`starhermit package --web .`); never edited by hand |
| `native/main.ts` | Entry module: screen flow, rounds and their snapshot, the play controller (selection, merges, moves, deliveries, drags, lesson gating), events → sounds and announcements, Undo / Hint / camera, results, progression, achievements, the device's daily board, score posting, input actions, the fixed-step clock and the lifecycle |
| `native/screens.ts` | Every screen, the HUD (rails or drawers and the thumb tray, the lesson banner, the 2D board), the dialogs and toasts (`starhermit:ui`); layouts by window size |
| `native/render.ts` | The cabinet on `starhermit:scene`: tray, cells, item meshes and label tiles, diorama props, lantern, sparks and motes, rings, camera framed into the playfield, picking, the graphics look |
| `native/quality.ts` | The old presets and budgets keyed by the runtime's quality tier and level |
| `native/platform.ts` | The save (engine `saves`, foreign-save migration, conflict merge), the `localStorage` shim, the game's options (engine `settings`, legacy settings migration), the player, invite link, platform clock, leaderboard posting |
| `native/audio.ts` | Clips on the runtime's buses, the rendered ambience bed and music notes |
| `native/i18n.ts`, `native/style.ts`, `native/icons.ts` | Locale from the runtime's language; the converted style sheet, theme and high-contrast tokens; the emoji atlas |
| `src/engine/rules.js`, `src/engine/rng.js` | Pure deterministic rules (`createGame`, `legalActions`, `applyCommand`, scoring, terminal checks, `replay`) and the seeded streams/hashes |
| `src/content.js` | Chains, five themes, 40 journey stages, daily/practice/challenge generators, four lessons, `validateLevel` |
| `src/session.js` | `GameSession`: command log, undo stack, elapsed clock (`clock.now`, the engine's fixed steps), replay envelope, snapshots |
| `src/persist.js` | Checksummed save document, board snapshot, guest id, `ACHIEVEMENTS`, `DEFAULT_SETTINGS`, `mergeSaves` |
| `src/i18n.js`, `src/locales/*.js` | Localization core (`T`, `N`, `setLocale`) and the en-GB, es (es-419 + es-ES), de, fr (fr-FR + fr-CA), pt-BR and it-IT dictionaries keyed by the US-English text |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished round's total and posts it to the `high-score` leaderboard (canonical copy, games repo `tools/score-script.js`) |
| `assets/` | `key-art.webp`, `cabinet-restored.webp`, `cabinet-locked.webp`, `icons.png` (emoji atlas), `ui-style.json` (converted styles) |
| `sfx/` | 15 Opus clips, `manifest.txt` (canonical), `manifest.json`, `manifest.md` |
| `tools/` | `ui-style.css` + `css.mjs` (styles), `package-web.mjs`, `gen-plays.mjs` (play scripts from the rules), `emoji-atlas.mjs`, `browser-play.mjs` (GPU Chrome check) |
| `tests/` | `rules.test.mjs`, `save.test.mjs`, `i18n.test.mjs` + `i18n-keys.mjs` (node --test), `native.mjs` + `native/*.play` (engine checks) |
| `coverart.png`, `cover.jpg`, `icon.png`, `LICENSE.md` | Distribution metadata |

## 2. Vision and design pillars

Discovery Merge is a quiet cabinet-keeper fantasy: a lamp-lit desk, a felt-lined tray, and the small joy of turning two pebbles into a fossil. The pillars below decide every rule and effect in the game.

1. **Every tap is a discovery, never a chore.** Generators are infinite and free; the only cost of a tap is board space and one action. Rules in: unlimited Field Kit charges in every authored level, tier-0 discovery points on the very first spawn. Rules out: energy, cooldowns, timers that stop play, paid boosts.
2. **The board is the only truth.** Anything that matters is visible on the tray: crates, cobwebs, tier pips on every piece, the selected piece's legal merge targets outlined in green. Rules in: `legalActions()` drives hints, tutorials and the deliver buttons alike. Rules out: hidden modifiers, off-board inventory, random surprise effects.
3. **Requests give merging a destination.** The win condition is fulfilling request cards, not reaching a top tier; the score rewards the finished card far more than the merge. Rules in: 150-point completion bonus, "Deliver" as a first-class action with drag-to-card. Rules out: infinite score chase inside a board, merging for its own sake.
4. **Fair, replayable, inspectable.** Every level is a seed plus visible parameters; every round is an ordered command log that replays exactly (`replay`). Rules in: seeds printed on the setup and results screens, deterministic ids, exact hash matching. Rules out: hidden difficulty scaling, undo in ranked modes.
5. **A cabinet you can operate blind.** The 3D tray is a presentation of a semantic grid that stays keyboard- and screen-reader-operable at all times. Rules in: a named target per cell (or the 2D board's cell buttons), announcements for every event. Rules out: canvas-only controls, hover-only information, audio-only cues.

## 3. Player experience

**Target player:** someone who likes tidy, low-stress puzzle sessions (merge games, sorting games) and enjoys collecting; comfortable on a phone, happy on a desktop.

**First 60 seconds.** The title screen shows the key art, one big Play button and three cards (Daily Cabinet, Journey, Curator Profile). Play opens the mode grid where Learn is first. Learn runs four lessons that each introduce one rule and gate input until the player performs it (`tutorialAllows` in `native/main.ts`): 1 tap the Field Kit, 2 merge a pair, 3 deliver to a request, 4 clear a cobweb. Each step shows in the lesson panel (the Requests rail when wide, a banner above the board when compact) and is announced; any other action plays the invalid cue and repeats the step text. Journey stage 1 ("First Shelf") is a 5×5 board with one chain and two tier-1 requests, so a player who skips Learn still meets only tap, merge and deliver. Every setup screen states board size, mechanics in play, request count, expected minutes, seed, move limit if any and whether the round is ranked before the player commits.

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

### RNG and seeding

`createRng(seed)` is mulberry32 (`rng.js`); the rules stream is part of the serialized state so replays are bit-exact. Level layout uses a separate stream seeded `seed ^ 0x9e3779b9` (`content.js derive`). Journey seeds are `hashString("journey:<index>")`, dailies `hashString("daily:YYYY-MM-DD")`, challenges `hashString("challenge:<name>")`, practice `hashString("practice:" + <platform ms> + ":" + <frame>)`. Item ids are `seed:t<tick>` / `seed:init:<cell>` / `seed:gen:<cell>` so hashes are stable across processes.

### Undo and hints

Undo (`GameSession.undo`) pops a serialized pre-command state; allowed only when `allowUndo` (Practice and Learn), never enters the log, capped at 200 entries. Hint (`GameSession.hint`) priority: first legal delivery → highest-tier merge → first tap; shown for 2.6 s as a pulsing ring in 3D and a sky outline in 2D, announced and toasted, with the `hint` cue; hidden when Hints enabled is off.

## 5. Modes and progression

| Mode | Content | Undo | Ranked | Board |
|---|---|---|---|---|
| Learn | 4 authored lessons (`tutorialLevels`), 4×4/5×5, tools chain only | yes | no | atelier |
| Journey | 40 stages (`journeyLevel(i)`), 8 per theme, stage 8 of each wing is a mastery stage with a move limit | no | yes (local best per stage) | theme by wing |
| Daily | `dailyLevel(date)`: one seed per UTC day from the platform's clock | no | yes; posts to the high-score board | random theme |
| Practice | easy / medium / hard (`PRACTICE_DIFFICULTIES`), fresh seed each time | yes | no | theme by hash of difficulty |
| Challenge | Frugal Hands (move limit 1.3× minimum), Brisk Catalog (par-clock chase, observatory), Crowded Shelves (5×5, 6 crates, 3 cobweb pairs, ember) | no | yes; posts to the high-score board | fixed |
| Score Chase | Today's daily board (this device); copy today's seed; play another day's cabinet by its date (unranked, records nothing) | — | — | — |

**Journey curve** (all from `journeyLevel`): board 5×5 for stages 1–8, 6×6 for 9–24, 7×7 for 25–40. Chains 1 (stages 1–6), 2 (7–14), 3 (15+), ordered per theme so each wing leads with a different chain. Crates from stage 6, rising to 6 by stage 33. Cobweb pairs from stage 7, up to 4 by stage 28. Request tiers 1–2 early, minimum tier 2 from stage 15, maximum tier 5 from stage 25 (mastery stages add +1 earlier). Two-need requests from stage 21, double counts from stage 29. Mastery stages get one extra request and `moveLimit = ceil(1.45 × minimum actions)`. Par seconds are always `ceil(3.2 × minimum actions)` where a tier-t piece costs `2^(t+1) − 1` actions plus one delivery (`minActionsForNeeds`).

**Daily**: 6–7 cells square, 3 of the 4 chains, 2–4 crates, 1–3 cobweb pairs, 4 requests of 1–2 needs up to tier 3–4. The UTC day comes from the platform's clock (`serverNow`), else the device's clock offline. A day's first win is stored in `save.dailies[date]` and added to the local board; later wins update the local best only.

**Unlocks**: journey stages unlock strictly in order; the diorama's eight pedestal props appear at `round(8 × completed/40)`. The Codex modal shows the highest tier ever created per chain (`save.codex`). Six achievements (`persist.js ACHIEVEMENTS`): First Restoration, Deep Discovery (tier-5 item), Web Clearer (10 cobwebs), Steady Hands (3 daily days), Mastery Archivist (all 5 mastery stages), Grand Curator (all 40).

## 6. Controls and interaction

Actions (`starhermit.txt`; players rebind keys and pads in the runtime's Options, or from Settings → Change keys and buttons):

| Action | Keys | Gamepad | Pointer / touch |
|---|---|---|---|
| Move board focus | arrows | D-pad, left stick | — |
| Select / confirm the focused cell (`select`) | Enter, Space | A (South) | tap or click a cell |
| Cancel selection, close a drawer, else pause (`cancel`) | Escape | B (East) | tap the selected piece again |
| Pause (`pause`) | P | Start | tray / rail Pause |
| Undo, Practice and Learn only (`undo`) | U | Y (North) | Undo button |
| Hint (`hint`) | H | X (West) | Hint button |
| Reset camera (`camera`) | C | right stick press | Reset camera button |

On the board: tap a Field Kit to produce an item; select a piece, then tap an identical piece to merge or an empty cell to move; with a piece selected, a request card's "Deliver selected piece" delivers it. On the 3D board a drag of a free piece past 12 px selects it and drops it on a piece (merge), an empty cell (move) or a request card (deliver); the green ring follows the cell under the finger. Keyboard and pad players move a focus ring (green) over the cells; Enter acts on the focused cell as a tap would. With the 2D board on, every cell is a button widget (Tab and arrows reach them; Enter or a tap activates). On compact layouts a press on the board closes an open drawer. Escape on the modes, journey and set-up screens goes back. F1 opens the runtime's menu.

**Input locking**: after any accepted command input is locked for 260 ms (the non-interruptible resolution phase); the results open 700 ms after a terminal event; both count the runtime's fixed steps. Duplicate command ids are rejected idempotently in `GameSession.dispatch`.

**Feedback for every input**: tap → `tap` cue and spawn pop; select → `select` cue, gold ground ring (3D) / gold outline (2D), an announcement listing what can be done; legal merge targets outlined green on the 2D board; invalid → `invalid` cue, a short vibration (Haptics on, devices that have one), cell shake in 3D, an assertive announcement and a toast from `INVALID_TEXT`; crates announce "A crate blocks that cell."

## 7. Screens and UI flow

`title ⇄ modes ⇄ {journey | setup} → play ⇄ pause dialog → results → (title | next stage | retry)`. Each screen focuses its main control a frame after it opens (Play, the first mode, stage 1, Start or the first list card, Retry). Dialogs (pause, Codex, How to play, Curator Profile, Settings, the erase check) are modal; Settings and Help opened from the pause dialog return to it, the erase check to Settings; Escape closes the top one (never on the frame that opened it). A hidden window pauses the round and stores its snapshot; "Resume paused board" shows on the title while a snapshot exists.

- **Top bar**: compass and "Discovery Merge", the status line ("Local play — fully playable" as a guest, else "Playing as <name> · progress synced / saving… / cloud sync unavailable"), Help, Codex, Settings. Below 560 px (or when it does not fit) the buttons and the status go to their own rows.
- **Title**: key art (cover-fitted, at most 42 % of the height and leaving room for the menu; panel colour while it loads), tagline, Play, Daily Cabinet / Journey / Curator Profile cards (they wrap), Sign in with StarHermit (guests) and Invite a friend (signed in), Resume paused board.
- **Modes**: six cards in an auto-fill grid (min 240 px) with one-line rule summaries and ranked flags; Back.
- **Journey**: five theme groups of eight stage buttons (min 136 px); locked stages disabled; names announce stage, best, locked and mastery.
- **Set-up**: level name, rules summary, the ⏱ minutes / 👤 players / 🎲 seed / 🎯 action-limit marks (atlas icons), Ranked/Unranked badge, the daily note, Start. Also hosts the Learn, Practice and Challenge lists and Score Chase (this device's daily table, Copy today's challenge seed, and a Shared seed date field with Play seed: another day's cabinet, unranked).
- **Play**, wide (≥ 1024 px, not short landscape): left rail Requests + lesson panel (240–304 px), the board between, right rail score / actions / timer / Pause / Undo / Hint / Reset camera (208–256 px); Left-handed layout swaps the rails. Compact: the board fills the window above the thumb tray (Pause, Undo, Hint, Requests, Score; reversed when left-handed, wrapping on phones); Requests and Score open drawers over the board (≤ 320 px); a lesson's step and its Finish lesson button sit in a banner above the board. The 3D board is framed into the playfield (`setViewOffset`); the page colour paints around it.
- **Countdown**: Ready, Set, Go! (0.48 s each) over the board; skipped with reduced motion.
- **Results**: headline (won green / lost red), illustration (`cabinet-restored.webp` / `cabinet-locked.webp`, sized to the room), breakdown, actions / invalid / elapsed / par / seed line, achievement lines, leaderboard line; Retry, Next stage (journey wins) and Home in a footer pinned to the bottom.

Must never be cut off: the Play button, the deliver buttons, the tray, the countdown, the results buttons. Pages taller than the window scroll; dialogs scroll their body and keep their buttons below it. Toasts (2.6 s, at most three) sit bottom-centre, above the tray in a round.

## 8. Art direction

**Hero**: the tray. The camera (`_frameCamera`) is an authored 38° perspective from the front-top, distance `span × 1.18` (landscape) or `× 1.5` (portrait, pushed back further when needed so the tray's full width fits the horizontal field of view), with an optional "top" tilt; the board is centred and rails never overlap it on desktop.

**Palette** (CSS tokens): background `#171310`, panel `#241d17`, panel-2 `#2e251d`, ink `#f2e9da`, ink-dim `#c4b6a2`, accent amber `#e0a458`, accent-2 sky `#8ecfff`, ok `#9fe08a`, danger `#ff7a6b`. Chains: tools `#c98f3d`, relics `#8d6bc9`, flora `#4d9e5f`, curios `#3d8fc9`. Themes (`THEMES`): Atelier of Dawn (sky `#2a2018`, key `#ffd9a0`, board `#8a6b4a`), Verdant Conservatory (`#16251c`, `#d8ffd2`, `#4f6b4a`), Midnight Observatory (`#0e1226`, `#aec4ff`, `#39406b`), Tidepool Grotto (`#0f2226`, `#a8f0e6`, `#3d6b6b`), Ember Archive (`#241317`, `#ffb08a`, `#6b4438`). High-contrast mode swaps to black panels, white ink, `#ffd24d` / `#66c2ff` accents.

**Shape language**: rounded felt cells in alternating tones on a walnut base; pieces are low rounded slabs carrying a chain-coloured label tile with the tier glyph and 1–6 pips; generators are brass-ringed cylinders with a slowly spinning torus; crates are dark banded boxes; cobwebs a translucent radial web decal. Selection is a gold ground ring, drag target green, hint blue and pulsing. Key art and illustrations are painterly lamp-lit miniatures in the same amber/walnut/cream palette.

**Graphics.** ACES tone mapping (exposure 1.18), a key directional light with an orthographic shadow box fitted to the tray and prop ring, and a hemisphere fill (the browser build's three r160 intensities). At the detailed tiers the tray is walnut-grained with a brass inlay rim, cells are speckled felt on rounded slabs, pieces are rounded clear-coated slabs, generators gain a softly pulsing glowing gem band and an idle bob, crates show planks and metal bands, the back wall shows panelling, and a hanging brass lantern adds a warm flickering point light. Image-based lighting (`RoomEnvironment` through `PMREMGenerator`) gives the materials restrained reflections. Post-processing is the renderer's: ambient occlusion, bloom (threshold 0.92, so only the gem bands, lantern glass and bright highlights bloom), the colour grade with vignette in display space, and FXAA/SMAA/MSAA. Dust motes drift through the lamplight on the higher tiers. Ambient motion stops under the runtime's reduced-motion option.

**Graphics levels.** The runtime's Options choose the graphics level (Auto from the device, or a level), the render scale, adaptive resolution, the frame-rate limit and readout; `native/quality.ts` maps the runtime's quality tier (`frame().quality`) to the old preset and its budget, and the level within the tier (`frame().levelIndex`, about 1.64× apart) scales sparks and motes up to 4× (capped at the pools). The old per-effect overrides are not offered. Changing the level rebuilds the tray, diorama and item meshes when the asset variants differ. Gameplay is identical at every level.

| Look | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows | off | 1024² | 2048² | 4096² |
| Ambient occlusion / bloom / grade | off / off / off | off / on / on | on / on / on | high / on / on |
| Anti-aliasing | MSAA | FXAA | SMAA | MSAA |
| Reflections, motes, detailed surfaces | off | on | on | on |
| Materials (tray, cells, pieces, crates, props) | Lambert | Standard | Physical (clearcoat pieces) | Physical |
| Rounded-box segments of pieces (cells/crates half) | 1 | 2 | 4 | 6 |
| Pedestal / torus-knot artefact segments | 8 | 12 | 20 | 32 |
| Sparks per merge burst (pool 240; low particles ≤ 18) | 12 | 20 | 40 | 60 |
| Dust motes (pool 90) | 16 | 30 | 60 | 90 |
| Bloom / AO resolution | ½ / ½ | ½ / ½ | ½ / ½ | full / full |

**Typography**: the runtime's serif face (`ui.setFont({ family: "serif" })`) at 16 px; the runtime's interface and text size options scale it. Headings are 700 weight in the style sheet (the generic serif face may draw them regular).

**Motion**: spawn scale-in 0.28 s, merge pulse 0.22 s, move slide 0.25 s ease-in-out, camera reframe 0.6 s, win/lose camera pulse 0.5 s, particle bursts of 40 from a 240-point pool. Reduced motion (the runtime's option) snaps every tween to its end state, disables shakes, pulses, ring spin and bursts except the win burst, and skips the countdown. The countdown is drawn at 96 px, capped at 240 window pixels on high-DPI screens (the web runtime leaves out taller glyphs).

**Visual assets the design calls for**: title key art, win illustration, lock-up illustration, cover art, favicon/icon — all shipped (see §15). Board geometry stays procedural by design; no external models. Item icons are the browser build's emoji, rendered once from Noto Color Emoji into `assets/icons.png` (`tools/emoji-atlas.mjs`): the engine's fonts have no colour emoji.

## 9. Audio direction

Everything is short, wooden, brass and glass — cabinet sounds, not arcade sounds. Sounds play on the runtime's buses, whose volumes, mute and voice limit are in its Options: the music on `music`, effects and the ambience bed on `effects`; the old default bus levels (music 60 % × 0.5, effects 80 %, ambience 50 % × 0.35) are folded into each sound's gain. A hidden window or the pause dialog holds the ambience and music. In browsers audio starts at the first press. Music is a seeded minor-pentatonic sine arpeggio (root 196 Hz, one note every 620 ms, now and then an octave up), its notes rendered once into clips; the ambience is two seconds of seeded noise low-passed at 320 Hz, rendered into a looping clip. Clips load one at a time once the mixer runs; a cue whose clip is still loading is silent (the browser build's synthesized stand-ins are not ported: live synthesis graphs make clip loads fail on the web runtime).

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

All player-facing text ships in the nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT. Strings are authored in US English and looked up by that text (`T('Play')`, `{name}` placeholders) through `src/i18n.js`; `src/locales/` holds the dictionaries (en-GB lists only spelling differences, es-ES and fr-CA only their differences from es-419 and fr-FR). Content tables (`src/content.js` chain, tier, theme, stage, challenge and lesson texts; `ACHIEVEMENTS`; `INVALID_TEXT`) keep the English keys and are translated at display time, so saves and board snapshots stay language-neutral.

**Language source.** The runtime's interface language (`preferences().language`: Options → Language, else the account's preferred language, else the device's) picks the nearest shipped locale (`native/i18n.ts`); the old in-game Language selector is gone. A change re-renders everything at once (the UI is immediate mode); the round, its clock and the save are untouched. Layout allowances: text that does not fit wraps (`ui.paragraph`), buttons wrap their label or their row, cards wrap.

## 11. Accessibility

- **Keyboard and pad path**: title → Play → mode card → set-up → Start → arrows move the board focus → Enter taps/selects → Tab reaches the Deliver buttons (wide) or the tray's Requests drawer (compact) → results buttons. Escape cancels, closes or pauses.
- **Screen readers**: every widget has a name; in 3D each cell is a named target (`ui.target`, the old `describeCell` text: item, tier, cobweb state, row and column); on the 2D board each cell is a button with that name. Announcements: screen and step changes, selections, discoveries, request completion, hints (polite); invalid actions and the results headline and total (assertive).
- **Contrast and colour**: ink on panel exceeds 10:1; chain colour is reinforced by the icon and tier pips, plus a chain-letter badge on the 2D board in colour-vision-safe mode; the runtime's high-contrast option swaps the palette (black panels, white ink, `#ffd24d` / `#66c2ff` accents) and the label tiles.
- **Options**: reduced motion, high contrast, interface and text size, volumes and mute in the runtime's Options; in Settings: Left-handed layout, Use 2D board, Camera tilt (default / top-down), Colour-vision-safe palette, Haptics (a short vibration on refused actions), Hints enabled (hides the Hint button and the key), Replay tutorials, Change keys and buttons, Erase local progress.
- **Targets**: every button ≥ 44 logical px tall; 2D cells 41.6–67.2 px.

## 12. StarHermit integration

The game is an engine script game; all platform access goes through the runtime (`starhermit:platform`, `starhermit:storage`); the game never sees a token.

- **Player**: `player()` (signed in or a guest); the top bar and Curator Profile show the display name; guests keep the local `guest-…` id (engine storage). Guests sign in through the runtime's Account dialog (title → Sign in with StarHermit, `requestSignIn`).
- **Save**: persist.js's checksummed document is the game's save (`saves`, schema 1) on the device and in the account's cloud slot. A conflict between two devices merges both with `mergeSaves` (better journey score per stage, daily completion OR and higher score, union of streak days and lessons, max codex tier and lifetime stats, earliest achievement unlock, de-duplicated device daily board). When the account's copy replaces the device's it is merged in. **Migration**: the browser build's slot (`game:<slug>`, the JS SDK's `saveJSON` of the same document) shows as foreign; it is parsed (`parseSave`), merged with the device's progress and saved over once (`replaceForeign`). Guests' old browser `localStorage` progress cannot migrate.
- **Options**: the game's options (above) are `settings` keys (synced with the account). Their first values come from the browser build's account settings (its mirrored save settings, read through `settings.legacy`) or, failing those, from the save document's `settings`; then the old keys (the save-settings keys, `graphics`, `quality`, `ui.language`, `audio.options`, `graphics.gpu.*`) are removed.
- **Clock**: the daily cabinet's date is the platform's clock (`serverNow`), else the device's UTC date when offline.
- **Leaderboard**: signed in, every finished Journey, Daily or Challenge round posts its total through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores: { 'high-score': total } }`; the script range-checks it, 0–100,000, and posts it to the `high-score` board, higher is better); the results show "Leaderboard rank: #N" (or posted / not posted). Learn, Practice and shared seeds post nothing; guests post nothing and show no line.
- **Invite link**: signed in, the title shows "Invite a friend": copies the platform invite link (shown in a toast if copying is blocked).
- **Controls**: the `control.*` / `engine.gamepad.*` actions above; rebinding is the runtime's.
- **Report a problem, crash reports, sound and frame-rate options, language, graphics**: the runtime's own.

Not used: platform achievements (achievements are local), multiplayer sessions, matchmaking, rooms, chat, replays, voice.

## 13. Technical architecture

- **Rules** are pure; the session is the only writer of rules state; `render.ts` and `screens.ts` read snapshots and event lists. UI state (selection, focus, drawers, dialogs) never touches simulation state.
- **Time**: the runtime's fixed steps (60 Hz) drive the session clock, the countdown, the input lock, the hint's 2.6 s, the results delay and the tweens, so play scripts replay exactly; ambient motion follows the rendered frame.
- **Determinism/replay**: `replayEnvelope()` = schema 1, rules and content versions, level id, seed, initial hash, ordered commands, per-command hashes, result; `replay(level, commands)` rebuilds any round.
- **Persistence**: the save document (engine save); the paused board's snapshot (`discovery-merge.snapshot.v1`, engine storage, written after each action, every 5 s, on pause, on a hidden window and on quit); the guest id. persist.js keeps calling `localStorage`, a shim in `native/platform.ts`.
- **Rendering**: one scene; the camera is active only in a round. Geometries are shared; meshes and materials are disposed when replaced. A full 7×7 board is ≈ 170–200 meshes and one 240-point spark cloud.
- **Pure logic as ES modules**: `src/` is imported by the TypeScript (`allowJs`) and by the node tests unchanged.

## 14. Testing and acceptance criteria

`npm test` runs:
- `npm run test:unit` (node --test): `rules.test.mjs` (spawn determinism, charges, merge/mismatch/max-tier, cobweb and move rules, delivery and win, move-limit and no-legal-moves losses, serialization, replay hashes, scoring, time bonus, malformed-command fuzz, `validateLevel` on every stage, greedy winnability), `save.test.mjs` (the browser build's cloud document parses, `mergeSaves` keeps the better side and seals again, the injectable session clock), `i18n.test.mjs` (every `T`/`N` key in `src/` and `native/` and every content string exists in all locales with the same placeholders; no stale keys).
- `npm run test:native` (`tests/native.mjs`): the web index matches the files, `tsc` (no `skipLibCheck`), `starhermit check .` with no warnings, and every `tests/native/*.play` as a signed-out render check driving the real UI: `journey-stages.play` (generated by `tools/gen-plays.mjs`: stage 1 played by keys to "Cabinet restored!", deliveries through the Requests drawer, Next stage plays stage 2, Home shows 2 / 40), `learn-lesson.play` (Lesson 1 by keys, Finish lesson, results), `practice-board2d.play` (Settings → Use 2D board, a Practice board by clicks: Field Kit, Undo, Hint, Escape pauses, Leave round, Resume paused board restores it), `screens.play` (Help, Codex, Profile, the Daily set-up, Score Chase, a Challenge round with a touch on a cell target, Pause → Help → Resume, the Score drawer).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in Chrome on the GPU at desktop 1366×768, phone 390×844 (DPR 3) and phone landscape 844×390 — Play, Learn, Lesson 1, the Field Kit tapped twice (keys on desktop, taps on the phones) — failing on console errors or warnings or the runtime's error screen.

QA bar: no console errors or warnings; no text or control clipped at 1366×768, 960×540, 390×844 or 844×390; every feature reachable by visible UI.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200×672, 68 KB) | Title-screen hero | FLUX.2 klein, seed 2020, 28 steps | generated in this pass, wired |
| `assets/cabinet-restored.webp` (640×400, 26 KB) | Results illustration on a win | FLUX.2 klein, seed 2021 | generated in this pass, wired |
| `assets/cabinet-locked.webp` (640×400, 24 KB) | Results illustration on a loss | FLUX.2 klein, seed 2022 | generated in this pass, wired |
| `coverart.png` (1200×675, 356 KB) | Platform cover | key art scaled and palettised | replaced in this pass (previous file was a generic placeholder) |
| `icon.png` | Platform icon | authored | shipped |
| `assets/icons.png` | Item and mark icons (34 emoji, 128 px cells) | Noto Color Emoji via `tools/emoji-atlas.mjs` | shipped |
| `sfx/*.opus` × 12 (tap … undo) | Core cues, see §9 | MOSS-SoundEffect v2.0 | shipped |
| `sfx/hint-glimmer.opus`, `sfx/web-clear.opus`, `sfx/achievement-medal.opus` | hint, webClear, achievement cues | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` | Canonical clip → event → description → usage list | hand-written | added in this pass |
| Board, pieces, generators, crates, cobwebs, diorama props | In-game 3D | procedural (`native/render.ts`), canvas-drawn label tiles | shipped |
| 3D models / character animation | — | not called for (no hero prop, no humanoid) | n/a |

## 16. Known limitations

- The daily board is per-device only; there is no shared daily ranking.
- Leaderboard scores are client-reported totals, range-checked by `score-script.js` (the platform's policy for solo games).
- `legalActions` lists one direction per mergeable pair (lower cell → higher cell) so hints never suggest merging onto the lower cell, although `applyMerge` accepts either direction when the player chooses it.
- Stage 5 lists "crates block cells" in its rules summary but its crate count is 0; crates first appear on stage 6.
- "Brisk Catalog" differs from a standard 6×6 board only by theme; its speed target is the ordinary par-clock time bonus.
- Practice seeds come from the platform clock and the frame count and cannot be shared or replayed after the round.
- Erase local progress saves a fresh document, which also replaces the account's cloud copy.
- Guests' progress kept in the old browser build's `localStorage` does not carry over (cloud saves do).
- Music and ambience are synthesized; there are no authored music stems.
- On the web runtime a glyph taller than about 256 window pixels is dropped from the overlay; the countdown is capped to stay under it.

## Design intent not yet implemented

- Per-locale number and time formatting.
- Friends filter on the daily board; platform achievement unlocks mirroring the six local ones.
- Enumerating both merge directions in `legalActions` so hints can free the more useful cell.
- Distinct "speed" rules for Brisk Catalog (tighter par, visible countdown).
- Haptic pulses on merge and request completion.
