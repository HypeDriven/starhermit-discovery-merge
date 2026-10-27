// The browser build's emoji icons (item tiers, the Field Kit, crates,
// cobwebs, the setup and profile marks), as slices of assets/icons.png — the
// runtime's fonts have no colour emoji, so tools/emoji-atlas.mjs renders
// these once from Noto Color Emoji, 128 px each, 8 to a row, in this order.
// The UI draws them with draw.image; the board's label tiles (render.ts)
// draw them into their canvases.
import { createImageBitmap, type ImageBitmap } from "starhermit:canvas";
import * as draw from "starhermit:draw";

export const ICONS = [
  "🧹", "⛏️", "🏮", "🧭", "🗺️", "⏳",
  "🔶", "📿", "🧿", "🗿", "🎭", "👑",
  "🌱", "🌿", "🌸", "🪷", "🎍", "🌳",
  "🪨", "🦴", "🥚", "💎", "🔮", "🌟",
  "⚙️", "📦", "🕸️", "❔", "🏅", "⬜", "⏱️", "👤", "🎲", "🎯",
];
export const CELL = 128;
const COLS = 8;

let atlas: ImageBitmap | null = null;
let asked = false;
const waiting: (() => void)[] = [];
/** Loads the atlas once; fn() when it is ready (at once if it is). */
export function whenIcons(fn: () => void): void {
  if (atlas) { fn(); return; }
  waiting.push(fn);
  if (asked) return;
  asked = true;
  createImageBitmap("assets/icons.png").then((b) => {
    atlas = b;
    for (const f of waiting.splice(0)) f();
  }, (e: unknown) => console.warn(`icons: ${String(e)}`));
}
export function iconAtlas(): ImageBitmap | null { return atlas; }

/** The atlas cell of an emoji (variation selectors ignored), or -1. */
export function iconIndex(emoji: string): number {
  const bare = (s: string): string => s.replace(/️/g, "");
  const b = bare(emoji);
  return ICONS.findIndex((e) => bare(e) === b);
}
/** The source rectangle of an icon in the atlas (whole pixels inside the bitmap). */
export function iconRect(i: number): { x: number; y: number; width: number; height: number } {
  return { x: (i % COLS) * CELL, y: Math.floor(i / COLS) * CELL, width: CELL, height: CELL };
}

/** Draws an emoji's icon into a window rect (nothing until the atlas is loaded). */
export function drawIcon(emoji: string, x: number, y: number, size: number, opts: { alpha?: number; grey?: boolean } = {}): void {
  whenIcons(() => undefined);
  const i = iconIndex(emoji);
  if (i < 0 || !atlas) return;
  const tint = opts.grey ? `#9a9a9a${opts.alpha != null ? Math.round(opts.alpha * 255).toString(16).padStart(2, "0") : ""}`
    : opts.alpha != null ? `#ffffff${Math.round(opts.alpha * 255).toString(16).padStart(2, "0")}` : undefined;
  draw.image(atlas, x, y, size, size, { source: iconRect(i), ...(tint ? { tint } : {}) });
}
