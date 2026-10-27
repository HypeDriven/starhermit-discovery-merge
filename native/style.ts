// The look of the menus, HUD and dialogs: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (checkboxes, selects, text
// fields, dialogs, scroll bars) take, in the browser build's serif face. The
// old body.high-contrast palette is a token set here, applied while the
// runtime's high-contrast option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const INK = {
  bg: "#171310", panel: "#241d17", panel2: "#2e251d", ink: "#f2e9da", dim: "#c4b6a2", accent: "#e0a458", accent2: "#8ecfff",
  danger: "#ff7a6b", ok: "#9fe08a", line: "#4a3d2f",
};
export const INK_HC = { ...INK, bg: "#000000", panel: "#0d0d0d", panel2: "#1a1a1a", ink: "#ffffff", dim: "#d8d8d8", accent: "#ffd24d", accent2: "#66c2ff" };
type Tokens = Record<string, string | number>;
let base: Tokens = {};
const HIGH_CONTRAST: Tokens = {
  bg: INK_HC.bg, panel: INK_HC.panel, "panel-2": INK_HC.panel2, ink: INK_HC.ink, "ink-dim": INK_HC.dim, accent: INK_HC.accent,
  "accent-2": INK_HC.accent2, line: "#8a8a8a",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setFont({ family: "serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 12,
    text: INK.ink, muted: INK.dim, panel: INK.panel, control: INK.panel2, hovered: "#3a2f24",
    pressed: "#1f1913", field: INK.panel2, accent: INK.accent, focus: INK.accent2, outline: INK.line,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$accent-2", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 44,
      parts: { box: { background: "$panel-2", border: { width: 1, color: "$line" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "$panel-2", border: { width: 1, color: "$line" }, radius: 8, minHeight: 40 },
    textField: { text: { color: "$ink" }, background: "$panel-2", border: { width: 1, color: "$line" }, radius: 8, minHeight: 40 },
    dialog: {
      background: "$panel", radius: 16, padding: 20, border: { width: 1, color: "$line" },
      parts: { backdrop: { background: "#0a0806b8" } },
    },
    scrollArea: { parts: { bar: { background: "$ink-dim", radius: 4 } } },
    tooltip: { background: "$panel-2", text: { color: "$ink" }, radius: 6, padding: 6 },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
export function ink(highContrast: boolean): typeof INK { return highContrast ? INK_HC : INK; }
