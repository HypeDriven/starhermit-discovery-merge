// Every player-facing string exists in all nine locales (node --test).
// Keys are the US-English source strings: literal T('…') / N('…') calls in
// src/, data-i18n markup in index.html, and the display fields of the
// content tables (chains, themes, stages, challenges, lessons, achievements).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LOCALES, T, setLocale } from '../src/i18n.js';
import { GFX_STRINGS } from '../src/gfx-panel.js';
import { ALL } from './i18n-keys.mjs';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 300, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('the Graphics panel has strings for all nine locales', () => {
  for (const locale of LOCALES) assert.ok(GFX_STRINGS[locale]?.title, locale);
});

test('T falls back to the key and fills placeholders', () => {
  setLocale('de-DE');
  assert.equal(T('Not a real key {x}', { x: 1 }), 'Not a real key 1');
  assert.equal(T('Stage {n}, {name}', { n: 2, name: 'X' }), 'Etappe 2, X');
  setLocale('fr-CA');
  assert.equal(T('score'), 'pointage');
  assert.equal(T('Merges'), 'Fusions'); // inherited from fr-FR
  setLocale('en-US');
  assert.equal(T('Merges'), 'Merges');
});
