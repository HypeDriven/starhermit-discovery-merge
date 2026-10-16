// Key extraction for the i18n coverage test (also handy for listing keys).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, THEMES, CHALLENGES, JOURNEY_COUNT, journeyLevel, tutorialLevels } from '../src/content.js';
import { ACHIEVEMENTS } from '../src/persist.js';

const ROOT = new URL('..', import.meta.url).pathname;

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === 'locales' ? [] : files(p)) : p.endsWith('.js') ? [p] : [];
  });
}

const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  // Ternary keys are wrapped in N('…') at the call site, so plain calls cover them.
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  for (const f of files(join(ROOT, 'src'))) {
    if (f.endsWith('i18n.js')) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
  }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) keys.add(m[1]);
  return keys;
}

export function contentKeys() {
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const c of Object.values(CHAINS)) { add(c.name); for (const t of c.tiers) add(t.name); }
  add('Unknown');
  for (const t of THEMES) add(t.name, t.ambience);
  for (let i = 0; i < JOURNEY_COUNT; i++) add(journeyLevel(i).name);
  for (const c of CHALLENGES) add(c.name, c.blurb);
  for (const l of tutorialLevels()) { add(l.name); for (const s of l.tutorial.steps) add(s.text); }
  for (const a of ACHIEVEMENTS) add(a.name, a.desc);
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);

if (process.argv[1] && process.argv[1].endsWith('i18n-keys.mjs')) console.log(JSON.stringify([...ALL], null, 1));
