// Graphics quality model: presets, per-category overrides, GPU detection and a
// cost summary. Pure (no three.js, no DOM) so the Settings panel, the renderer
// and node tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  particles: ['low', 'high'],
  detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers, a device-pixel-ratio cap and a render scale.
const TABLE = {
  low: { dpr: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low', detail: 'plain' },
  balanced: { dpr: 1.5, scale: 0.9, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'high', detail: 'detailed' },
  high: { dpr: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', detail: 'detailed' },
  ultra: { dpr: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Auto picks the preset from the StarHermit hardware level (gpu-level.js → globalThis.StarHermitGpu,
// loaded before the game modules): 0 = Galaxy S20 / Intel UHD or weaker and every software renderer,
// 20 = RTX 5090, each level ≈ 1.23×. Low from 0, Balanced from 4, High from 10, Ultra from 17. Phones,
// tablets and ≤ 4 GB machines are capped at level 9 (Balanced) by the shared module.
export const PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return PRESET_LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, PRESET_LEVELS);
  return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
}

/** Best preset for this GPU (the level already caps phones and tablets at Balanced). */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Counts are tuned at
 * the preset's floor level and scale up within the preset on faster GPUs (StarHermitGpu.scaleBudget, ≤ 4×).
 *   material   'lambert' | 'standard' | 'physical' (tray, cells, pieces, crates, props; clearcoat when detailed);
 *   pieceSegs  rounded-corner segments of the detailed piece / cell / crate boxes;
 *   propSegs   pedestal and torus-knot artefact segments;
 *   burst      sparks per merge burst (pool 240); motes  dust motes in the lamplight (pool 90);
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame.
 */
export const BUDGETS = {
  low: { material: 'lambert', pieceSegs: 1, propSegs: 8, burst: 12, motes: 16, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', pieceSegs: 2, propSegs: 12, burst: 20, motes: 30, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', pieceSegs: 4, propSegs: 20, burst: 40, motes: 60, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', pieceSegs: 6, propSegs: 32, burst: 60, motes: 90, bloomRes: 1, aoRes: 1 },
};
const POOLS = { burst: 240, motes: 90 };

/** A preset's concrete budget for a hardware level (counts scale up within the preset, never down). */
export function budgetFor(preset, level = 0) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const floor = PRESET_LEVELS[preset] || 0;
  const G = gpuApi();
  for (const k of Object.keys(POOLS)) {
    b[k] = Math.min(POOLS[k], Math.round(G ? G.scaleBudget(b[k], Math.max(Number(level) || 0, floor), floor) : b[k]));
  }
  return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: tier }.
 * Missing / unknown category values mean "from preset".
 */
export function resolve(saved, detected, level = 0) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, dprCap: row.dpr, renderScale, scale: row.scale * renderScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.budget = budgetFor(preset, level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The post chain runs only when an effect needs it; otherwise canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override (keeps scale/adaptive/fps). */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale != null) out.render_scale = s.render_scale;
  if (s.adaptive != null) out.adaptive = s.adaptive;
  if (s.show_fps != null) out.show_fps = s.show_fps;
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Short cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Migrate the pre-preset `quality` setting (auto|low|medium|high). */
export function fromLegacyQuality(q) {
  if (q === 'low') return { preset: 'low' };
  if (q === 'medium') return { preset: 'balanced' };
  if (q === 'high') return { preset: 'high' };
  return {};
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
