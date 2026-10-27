# Discovery Merge

Combine identical objects to unlock a branching discovery chain and restore themed scenes — an explorer's cabinet that grows into a living diorama.

A StarHermit engine script game (engine 1.18.0): one package played natively by the StarHermit client and in browsers by the engine's web runtime. See `spec.md` for the full running spec.

## Run

```sh
STARHERMIT=~/sh/runtime/1.18.0/starhermit-1.18.0-linux-x86_64/starhermit
$STARHERMIT .            # play natively (a guest)
npm run package          # rewrite the web loader index.html + starhermit-files.json (after every change)
```

## Test

```sh
npm test                 # rules, save and i18n unit tests; tsc, starhermit check, the native play scripts
npm run test:browser     # the packaged loader in Chrome on the GPU (desktop, phone, phone landscape)
npm run plays            # regenerate tests/native/journey-stages.play from the rules
npm run css              # convert tools/ui-style.css into assets/ui-style.json
```

## Layout

- `native/` — the engine client (TypeScript): screens and HUD (`starhermit:ui`), the cabinet (`starhermit:scene`), sound, save and platform
- `src/engine/` — pure deterministic rules engine + seeded RNG (node-safe, unit-tested)
- `src/content.js` — chains, 5 themes, 40 journey stages, daily/challenge/practice generators, validator
- `src/session.js` — command log, undo, snapshots, replay envelopes
- `src/persist.js` — versioned, checksummed save document and its merge
- `src/i18n.js`, `src/locales/` — the nine locales
- `score-script.js` — platform script posting range-checked totals to the high-score board
- `starhermit.txt` — distribution manifest (engine pin, actions, `server=score-script.js`)
