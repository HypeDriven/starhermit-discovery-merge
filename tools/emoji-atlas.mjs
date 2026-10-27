// Renders the game's emoji icons (the browser build drew them as text: the
// item tiers of src/content.js, the Field Kit, crate, cobweb, the setup and
// profile marks) from Noto Color Emoji into assets/icons.png, a strip of
// 128 px cells in native/icons.ts's ICONS order: the runtime's fonts have no
// colour emoji. An offline tool (run once after changing the list); it uses
// Chrome through ~/games/tools/gpu-chrome.mjs.
//   node tools/emoji-atlas.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const { chromium } = createRequire(ROOT + 'package.json')('playwright-core');
const src = readFileSync(ROOT + 'native/icons.ts', 'utf8');
const list = src.match(/ICONS = \[([^\]]*)\]/)[1].match(/"[^"]*"/g).map((s) => JSON.parse(s));
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, close } = await launchChrome(chromium);
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
const data = await page.evaluate(async (icons) => {
  const S = 128, COLS = 8;
  const c = document.createElement('canvas');
  c.width = S * COLS; c.height = S * Math.ceil(icons.length / COLS);
  const g = c.getContext('2d');
  await document.fonts.load('100px "Noto Color Emoji"');
  g.font = '100px "Noto Color Emoji"'; g.textAlign = 'center'; g.textBaseline = 'middle';
  icons.forEach((e, i) => g.fillText(e, (i % COLS) * S + S / 2, Math.floor(i / COLS) * S + S / 2 + 6));
  return c.toDataURL('image/png');
}, list);
writeFileSync(ROOT + 'assets/icons.png', Buffer.from(data.split(',')[1], 'base64'));
console.log(`wrote assets/icons.png (${list.length} icons)`);
await close();
