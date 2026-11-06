// The browser build's emoji icons (item tiers, the Field Kit, crates,
// cobwebs, the setup and profile marks), drawn as font text as the browser
// build drew them: the engine's StarHermit Emoji has every one of them. Most
// draw in their own colours;
// ⛏️ ⚙️ 🕸️ ⏱️ are text-style in that font and draw in the given colour.
// Each icon's ink box is centred in its square and fills ICON_FILL of it
// (the old Noto atlas cells' share). The UI draws them with draw.text; the
// board's label tiles (render.ts) bake them into their canvases once the
// font is in (whenIcons).
import { fonts, OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import * as draw from "starhermit:draw";

export const ICONS = [
  "🧹", "⛏️", "🏮", "🧭", "🗺️", "⏳",
  "🔶", "📿", "🧿", "🗿", "🎭", "👑",
  "🌱", "🌿", "🌸", "🪷", "🎍", "🌳",
  "🪨", "🦴", "🥚", "💎", "🔮", "🌟",
  "⚙️", "📦", "🕸️", "❔", "🏅", "⬜", "⏱️", "👤", "🎲", "🎯",
];
/** The share of an icon's square its ink box fills (the old atlas: ~111 of 128 px). */
const ICON_FILL = 0.87;
const FONT = "'StarHermit Emoji', sans-serif";
const DRAW_FONT = "StarHermit Emoji";
const REF = 100;

let ready = false;
const waiting: (() => void)[] = [];
// Ask for the faces now: the emoji font loads only when text first needs it.
fonts.load(`${REF}px ${FONT}`, ICONS.join("")).then(() => { ready = true; for (const f of waiting.splice(0)) f(); }, (e: unknown) => console.warn(`icons: ${String(e)}`));
/** fn() once the icons' faces are in (at once if they are): a canvas bake waits for it. */
export function whenIcons(fn: () => void): void {
  if (ready) fn();
  else waiting.push(fn);
}

interface Ink { scale: number; dx: number; dy: number; asc: number }
const inks = new Map<string, Ink>();
let probe: OffscreenCanvasRenderingContext2D | null = null;
/** An icon's ink box at REF px: font size per pixel of its square, and the ink centre's offset from (align center, baseline). */
function inkOf(emoji: string): Ink {
  let m = inks.get(emoji);
  if (m) return m;
  probe ??= new OffscreenCanvas(4, 4).getContext("2d")!;
  probe.font = `${REF}px ${FONT}`;
  probe.textAlign = "center";
  probe.textBaseline = "alphabetic";
  const t = probe.measureText(emoji);
  const w = t.actualBoundingBoxLeft + t.actualBoundingBoxRight, h = t.actualBoundingBoxAscent + t.actualBoundingBoxDescent;
  m = { scale: (ICON_FILL * REF) / Math.max(1, w, h), dx: (t.actualBoundingBoxRight - t.actualBoundingBoxLeft) / 2 / REF, dy: (t.actualBoundingBoxDescent - t.actualBoundingBoxAscent) / 2 / REF, asc: t.fontBoundingBoxAscent / REF };
  if (ready) inks.set(emoji, m);
  return m;
}

/** Bakes an icon into a 2D canvas, centred at (cx, cy) in a `size` px square. */
export function fillIcon(g: OffscreenCanvasRenderingContext2D, emoji: string, cx: number, cy: number, size: number, color = "#f2e9da"): void {
  const m = inkOf(emoji), px = m.scale * size;
  g.save();
  g.fillStyle = color;
  g.font = `${px}px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText(emoji, cx - m.dx * px, cy - m.dy * px);
  g.restore();
}

/** Draws an emoji's icon into a window square (x, y the top-left). `grey` dims a
 * text-style icon to grey (colour emoji keep their colours; `alpha` fades both). */
export function drawIcon(emoji: string, x: number, y: number, size: number, opts: { alpha?: number; grey?: boolean; color?: string } = {}): void {
  const m = inkOf(emoji), px = m.scale * size;
  const base = opts.grey ? "#9a9a9a" : opts.color ?? "#f2e9da";
  const color = opts.alpha != null ? `${base}${Math.round(opts.alpha * 255).toString(16).padStart(2, "0")}` : base;
  // draw.text's y is the line box's top: the baseline sits the font's ascent below it.
  draw.text(emoji, x + size / 2 - m.dx * px, y + size / 2 - (m.dy + m.asc) * px, { size: px, font: DRAW_FONT, color, align: "center" });
}
