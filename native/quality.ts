// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the merge sparks and the dust motes scaled within the tier by the
// level (frame().levelIndex), as the browser build scaled them by its
// hardware level (at most 4×, never below the tier's floor, capped at the
// pools). The runtime owns the rest of what the old Graphics panel did:
// Auto and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Lit materials: Lambert, standard PBR, or clear-coated physical pieces. */
  material: "lambert" | "standard" | "physical";
  /** Rounded-corner segments of the detailed piece / cell / crate boxes. */
  pieceSegs: number;
  /** Pedestal and torus-knot artefact segments. */
  propSegs: number;
  /** Sparks per merge burst (pool 240); dust motes in the lamplight (pool 90). */
  burst: number;
  motes: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting from a neutral room. */
  reflections: boolean;
  /** Full spark bursts and the dust motes. */
  particlesHigh: boolean;
  /** Wood, felt, panel and plank textures, rounded pieces, the brass rim and the lantern. */
  detailed: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, particlesHigh: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particlesHigh: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particlesHigh: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particlesHigh: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", pieceSegs: 1, propSegs: 8, burst: 12, motes: 16, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", pieceSegs: 2, propSegs: 12, burst: 20, motes: 30, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", pieceSegs: 4, propSegs: 20, burst: 40, motes: 60, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", pieceSegs: 6, propSegs: 32, burst: 60, motes: 90, bloomRes: 1, aoRes: 1 },
};
export const POOLS = { burst: 240, motes: 90 };
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: the counts grow with the
  // level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.burst = Math.min(POOLS.burst, Math.round(b.burst * k));
  b.motes = Math.min(POOLS.motes, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
