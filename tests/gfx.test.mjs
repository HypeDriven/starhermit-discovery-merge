// Graphics quality model (src/gfx.js): detection, resolution, overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../gpu-level.js';
import { detectPreset, detectLevel, presetForLevel, budgetFor, BUDGETS, resolve, presetTier, choosePreset, describe, fromLegacyQuality, PRESETS, CATEGORIES } from '../src/gfx.js';

const desk = { webgl: true, webgl2: true, cores: 8, memoryGb: 8 };
const phone = { webgl: true, webgl2: true, mobile: true, cores: 8, memoryGb: 8 };

test('hardware level → preset: Low 0, Balanced 4, High 10, Ultra 17', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', desk), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', desk), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', desk), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', desk), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectPreset('', desk), 'balanced');
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are capped at Balanced; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', phone), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', phone) <= 9);
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', phone), 'balanced');
  assert.equal(detectPreset('Mali-G77', phone), 'low');
  assert.equal(detectPreset('SwiftShader', phone), 'low');
});

test('every preset has an explicit budget that grows from Low to Ultra and scales with the level', () => {
  const order = ['low', 'balanced', 'high', 'ultra'];
  const keys = ['material', 'pieceSegs', 'propSegs', 'burst', 'motes', 'bloomRes', 'aoRes'];
  const mats = ['lambert', 'standard', 'physical'];
  for (const p of order) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < order.length; i++) {
    for (const k of keys) if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[order[i]][k] >= BUDGETS[order[i - 1]][k], `${order[i]}.${k}`);
    assert.ok(mats.indexOf(BUDGETS[order[i]].material) >= mats.indexOf(BUDGETS[order[i - 1]].material));
  }
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('low', 3).motes > budgetFor('low', 0).motes, 'counts scale up with the level');
  assert.ok(budgetFor('low', 20).burst <= 4 * BUDGETS.low.burst, 'never more than 4×');
  assert.equal(resolve({ preset: 'balanced' }, 'low').scale, 0.9);
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({}, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.shadows, 'off');
  assert.equal(a.post, false); // Low is as cheap as before: no post chain
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, 'medium');
  assert.equal(h.post, true);
  for (const p of PRESETS) {
    const r = resolve({ preset: p }, 'low');
    for (const [cat, tiers] of Object.entries(CATEGORIES)) assert.ok(tiers.includes(r[cat]), `${p}.${cat}`);
  }
});

test('resolve: overrides, invalid values and render-scale clamp', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'bogus', render_scale: 5 }, 'high');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, presetTier('low', 'shadows'));
  assert.equal(r.post, true); // bloom override needs the chain
  assert.equal(r.renderScale, 2);
  assert.equal(resolve({ render_scale: 0.1 }, 'low').renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra' }, 'low').scale, 1.25);
  assert.equal(resolve({}, 'low').adaptive, true);
  assert.equal(resolve({ adaptive: false, show_fps: true }, 'low').showFps, true);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const next = choosePreset({ preset: 'low', bloom: 'on', detail: 'detailed', render_scale: 1.5, adaptive: false, show_fps: true }, 'high');
  assert.deepEqual(next, { preset: 'high', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(choosePreset({ ao: 'high' }, 'auto').preset, 'auto');
  assert.equal(resolve(next, 'low').bloom, presetTier('high', 'bloom'));
});

test('describe + legacy migration', () => {
  const s = describe(resolve({ preset: 'high' }, 'low'), [1280, 800]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /1280×800 px/);
  assert.deepEqual(fromLegacyQuality('medium'), { preset: 'balanced' });
  assert.deepEqual(fromLegacyQuality('auto'), {});
});
