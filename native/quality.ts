// The look per graphics level. The engine-owned effects come from the
// frame's level (levelSettings()): shadows on/off and the key light's map
// size (the game sets it; since minor 23 the runtime keeps a game's
// mapSize), ambient occlusion (resolution and samples), bloom resolution,
// the grade, anti-aliasing and the textures' anisotropy. The game's own art
// is the browser build's four presets and budgets (src/gfx.js TABLE /
// BUDGETS, each tuned to hold 60 FPS on the weakest GPU its Auto gave it),
// keyed by the runtime's quality tier (frame().quality); the merge sparks
// and the dust motes scale with the level's particle budget over the tier's
// anchor level (at most 4×, capped at the pools). The runtime owns the rest
// of what the old Graphics panel did: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit
// and readout, and the MSAA samples. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  /** The level's ambient occlusion (null = off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** The level's anisotropic filtering on the canvas textures. */
  anisotropy: number;
  /** Image-based lighting from a neutral room. */
  reflections: boolean;
  /** Full spark bursts and the dust motes. */
  particlesHigh: boolean;
  /** Wood, felt, panel and plank textures, rounded pieces, the brass rim and the lantern. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "particlesHigh" | "detailed">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, particlesHigh: false, detailed: false },
  balanced: { reflections: true, particlesHigh: true, detailed: true },
  high: { reflections: true, particlesHigh: true, detailed: true },
  ultra: { reflections: true, particlesHigh: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", pieceSegs: 1, propSegs: 8, burst: 12, motes: 16 },
  balanced: { material: "standard", pieceSegs: 2, propSegs: 12, burst: 20, motes: 30 },
  high: { material: "physical", pieceSegs: 4, propSegs: 20, burst: 40, motes: 60 },
  ultra: { material: "physical", pieceSegs: 6, propSegs: 32, burst: 60, motes: 90 },
};
export const POOLS = { burst: 240, motes: 90 };
/** Each tier's first level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a level's settings (the frame's level by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // The level's particle budget over the tier's anchor: the counts grow with
  // the level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.burst = Math.min(POOLS.burst, Math.round(b.burst * k));
  b.motes = Math.min(POOLS.motes, Math.round(b.motes * k));
  return {
    preset, ...ART[preset], budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    // Engine 1.36.1 bug: antialias "off" recolours fog, haze and translucent overlays (fix due in
    // 1.36.2), so Low keeps the old preset's MSAA; drop this when pinning 1.36.2+.
    antialias: s.antialias === "off" ? "msaa" : s.antialias,
    anisotropy: s.anisotropy,
  };
}
