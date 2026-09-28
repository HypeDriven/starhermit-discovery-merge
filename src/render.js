// Three.js presentation layer. Consumes immutable rules snapshots + event
// lists; never mutates game state. Board is a tabletop diorama in an
// explorer's cabinet: authored camera, PBR lighting with image-based
// reflections, pooled particles, semantic meshes per entity kind, explicit
// disposal, graphics presets (see gfx.js) with an optional post chain.

import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CHAINS, itemIcon, THEMES } from './content.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

const CELL = 1.15;
const PIECE_Y = 0.22;
const MOTES = 90;

// Colour grade + vignette, applied after tone mapping (display-space in/out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.26 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.07);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.2, 0.8, l));
      float d = length((vUv - 0.5) * vec2(1.0, 0.9));
      s *= 1.0 - uVignette * smoothstep(0.38, 0.85, d);
      gl_FragColor = vec4(s, src.a);
    }`,
};

// --- procedural surface textures (detail: detailed) -------------------------

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function canvasTex(key, size, draw, repeat = 1) {
  const cache = canvasTex.cache;
  if (cache[key]) return cache[key];
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  cache[key] = tex;
  return tex;
}
canvasTex.cache = {};

// Walnut grain: light base (the material colour tints it), wavy darker streaks.
function woodTexture() {
  return canvasTex('wood', 256, (g, n) => {
    const rnd = seeded(7);
    g.fillStyle = '#f2ece4';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 70; i++) {
      const y0 = rnd() * n, amp = 2 + rnd() * 6, f = 0.01 + rnd() * 0.03, ph = rnd() * 6;
      g.strokeStyle = `rgba(90,60,35,${0.05 + rnd() * 0.12})`;
      g.lineWidth = 0.6 + rnd() * 2.2;
      g.beginPath();
      for (let x = 0; x <= n; x += 4) {
        const y = y0 + Math.sin(x * f + ph) * amp;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
  });
}

// Felt: near-white speckle so each cell keeps its theme colour.
function feltTexture() {
  return canvasTex('felt', 128, (g, n) => {
    const img = g.createImageData(n, n);
    const rnd = seeded(11);
    for (let i = 0; i < n * n; i++) {
      const v = 226 + rnd() * 29;
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

// Cabinet back wall: vertical panels with grooves and a faint grain.
function panelTexture() {
  return canvasTex('panel', 256, (g, n) => {
    const rnd = seeded(23);
    g.fillStyle = '#e8e2da';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 120; i++) {
      g.fillStyle = `rgba(80,60,40,${rnd() * 0.06})`;
      g.fillRect(rnd() * n, 0, 1 + rnd() * 2, n);
    }
    for (let x = 0; x < n; x += n / 4) {
      g.fillStyle = 'rgba(40,28,18,0.45)';
      g.fillRect(x, 0, 3, n);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + 3, 0, 2, n);
    }
  });
}

// Crate planks.
function plankTexture() {
  return canvasTex('plank', 128, (g, n) => {
    const rnd = seeded(31);
    g.fillStyle = '#d8c8b4';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(70,45,25,${0.08 + rnd() * 0.12})`;
      g.lineWidth = 1;
      const y = rnd() * n;
      g.beginPath(); g.moveTo(0, y); g.lineTo(n, y + (rnd() - 0.5) * 6); g.stroke();
    }
    for (let y = 0; y < n; y += n / 4) {
      g.fillStyle = 'rgba(30,20,10,0.55)';
      g.fillRect(0, y, n, 2);
    }
  });
}

// Soft round sprite for particles.
function dotTexture() {
  return canvasTex('dot', 64, (g, n) => {
    const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
  });
}

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

// Canvas-drawn label texture: chain-colored tile, item glyph, tier pips.
function makeLabelTexture(chain, tier, highContrast) {
  const key = `${chain}:${tier}:${highContrast ? 1 : 0}`;
  if (makeLabelTexture.cache[key]) return makeLabelTexture.cache[key];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const info = CHAINS[chain];
  const base = highContrast ? '#141414' : (info ? info.color : '#888');
  g.fillStyle = base;
  g.beginPath();
  g.roundRect(4, 4, 120, 120, 22);
  g.fill();
  g.strokeStyle = highContrast ? '#ffffff' : 'rgba(255,255,255,0.35)';
  g.lineWidth = 5;
  g.stroke();
  g.font = '58px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(itemIcon(chain, tier), 64, 58);
  // Tier pips: shape reinforcement of numeric state.
  g.fillStyle = highContrast ? '#ffffff' : 'rgba(255,255,255,0.85)';
  for (let i = 0; i <= tier; i++) {
    g.beginPath();
    g.arc(64 + (i - tier / 2) * 14, 106, 4.4, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  makeLabelTexture.cache[key] = tex;
  return tex;
}
makeLabelTexture.cache = {};

function makeWebTexture() {
  if (makeWebTexture.tex) return makeWebTexture.tex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(235,235,245,0.9)';
  g.lineWidth = 2.5;
  const cx = 64, cy = 64;
  for (let a = 0; a < 8; a++) {
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a * Math.PI / 4) * 62, cy + Math.sin(a * Math.PI / 4) * 62);
    g.stroke();
  }
  for (let r = 16; r <= 56; r += 14) {
    g.beginPath();
    for (let a = 0; a <= 8; a++) {
      const wob = r + Math.sin(a * 2.3) * 3;
      const x = cx + Math.cos(a * Math.PI / 4) * wob;
      const y = cy + Math.sin(a * Math.PI / 4) * wob;
      if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  makeWebTexture.tex = new THREE.CanvasTexture(c);
  return makeWebTexture.tex;
}

export class BoardRenderer {
  // opts: { settings } — settings.graphics holds the saved graphics choices.
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.settings = opts.settings || {};
    this.theme = THEMES[0];
    this.level = null;
    this.state = null;
    this.meshById = new Map();
    this.cellMeshes = [];
    this.tweens = [];
    this.selected = -1;
    this.hintCells = [];
    this.dragTarget = -1;
    this.particlePool = [];
    this.restoration = 0;
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this._time = 0;
    this._disposed = false;
  }

  static gpuName(renderer) {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch { return ''; }
  }

  init() {
    let canvas;
    try {
      canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { return false; }

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('gl-canvas');
    this.gpu = BoardRenderer.gpuName(this.renderer);
    const touch = (navigator.maxTouchPoints || 0) > 0 || matchMedia('(pointer: coarse)').matches;
    this.detected = detectPreset(this.gpu, touch);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    this.keyLight.position.set(4, 8, 3);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight, this.keyLight.target);
    this.fillLight = new THREE.HemisphereLight(0xffffff, 0x223311, 1.25);
    this.scene.add(this.fillLight);

    this.boardGroup = new THREE.Group();
    this.itemGroup = new THREE.Group();
    this.fxGroup = new THREE.Group();
    this.scene.add(this.boardGroup, this.itemGroup, this.fxGroup);

    // Selection ring + drag-target ghost + hint rings (grounded markers).
    const ringGeo = new THREE.RingGeometry(0.42, 0.55, 32);
    this.selectRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xfff2b0, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
    this.selectRing.rotation.x = -Math.PI / 2;
    this.selectRing.visible = false;
    this.scene.add(this.selectRing);

    this.targetRing = new THREE.Mesh(ringGeo.clone(), new THREE.MeshBasicMaterial({ color: 0x9fe08a, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.visible = false;
    this.scene.add(this.targetRing);

    this.hintRing = new THREE.Mesh(ringGeo.clone(), new THREE.MeshBasicMaterial({ color: 0x8ecfff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
    this.hintRing.rotation.x = -Math.PI / 2;
    this.hintRing.visible = false;
    this.scene.add(this.hintRing);

    // Shared geometries: plain (boxes) and detailed (rounded, bevelled) sets.
    this.geos = {
      plain: {
        piece: new THREE.BoxGeometry(0.72, 0.4, 0.72),
        cell: new THREE.BoxGeometry(1.02, 0.14, 1.02),
        crate: new THREE.BoxGeometry(0.8, 0.62, 0.8),
      },
      detailed: {
        piece: new RoundedBoxGeometry(0.72, 0.4, 0.72, 4, 0.09),
        cell: new RoundedBoxGeometry(1.02, 0.14, 1.02, 2, 0.045),
        crate: new RoundedBoxGeometry(0.8, 0.62, 0.8, 2, 0.04),
      },
    };
    this.genGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.34, 32);
    this._sharedGeos = new Set([this.genGeo, ...Object.values(this.geos.plain), ...Object.values(this.geos.detailed)]);

    // Particle pool (bounded; one Points cloud reused for bursts) + dust motes.
    this._initParticles();
    this._initMotes();

    this.setGraphics(this.settings.graphics);
    this.resize();
    // Follow the container box (screen shows, chat sidebar, orientation).
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.container);
    }
    this.renderer.setAnimationLoop((t) => this._frame(t));
    return true;
  }

  get detail() { return this.q?.detail === 'detailed'; }

  _motionOff() {
    return !!this.settings.reducedMotion || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Standard material with a restrained environment-reflection strength.
  _std(params, env = 0.35) {
    const m = new THREE.MeshStandardMaterial(params);
    m.envMapIntensity = env;
    return m;
  }

  _initParticles() {
    const N = 240;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const mat = new THREE.PointsMaterial({ color: 0xffe9a8, size: 0.07, transparent: true, opacity: 0.9, depthWrite: false });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.raycast = () => {}; // cosmetic particles never intercept raycasts
    this.points.visible = false;
    this.fxGroup.add(this.points);
    this.particleData = new Array(N).fill(null).map(() => ({ life: 0, vel: new THREE.Vector3() }));
  }

  // Dust motes drifting in the lamplight (particles: high, motion allowed).
  _initMotes() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MOTES * 3);
    const rnd = seeded(97);
    this.moteSeeds = [];
    for (let i = 0; i < MOTES; i++) {
      pos[i * 3] = (rnd() - 0.5) * 9;
      pos[i * 3 + 1] = 0.3 + rnd() * 3.2;
      pos[i * 3 + 2] = (rnd() - 0.5) * 9;
      this.moteSeeds.push(rnd() * 100);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffe2b0, size: 0.06, map: dotTexture(), transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.motes.raycast = () => {};
    this.motes.visible = false;
    this.fxGroup.add(this.motes);
  }

  burst(worldPos, color = 0xffe9a8) {
    if (this.settings.reducedMotion) return;
    const cap = this.q?.particles === 'high' ? 40 : 18;
    this.points.material.color.setHex(color);
    this.points.material.size = this.q?.particles === 'high' ? 0.08 : 0.07;
    this.points.visible = true;
    const pos = this.points.geometry.attributes.position;
    let n = 0;
    for (let i = 0; i < this.particleData.length && n < cap; i++) {
      const p = this.particleData[i];
      if (p.life > 0) continue;
      p.life = 0.55 + Math.random() * 0.25;
      p.maxLife = p.life;
      p.vel.set((Math.random() - 0.5) * 3, 2 + Math.random() * 2.2, (Math.random() - 0.5) * 3);
      pos.setXYZ(i, worldPos.x, worldPos.y, worldPos.z);
      n++;
    }
    pos.needsUpdate = true;
  }

  // ---------------------------------------------------------------- graphics settings

  /** Apply saved graphics settings live (object from settings.graphics; {} = Auto). */
  setGraphics(saved) {
    if (!this.renderer) return;
    const key = JSON.stringify(saved || {}) + '|' + !!this.settings.reducedMotion;
    if (key === this._gfxKey) return;
    this._gfxKey = key;
    const prevDetail = this.q?.detail;
    const prevReflections = this.q?.reflections;
    const g = resolve(saved, this.detected);
    this.q = g;

    const size = SHADOW_MAP[g.shadows];
    const shadowsChanged = this.renderer.shadowMap.enabled !== size > 0;
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    this.renderer.shadowMap.needsUpdate = true;

    // Image-based lighting from a neutral room so PBR pieces pick up soft reflections.
    if (g.reflections === 'on' && !this.envTex) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this.envTex = pmrem.fromScene(room, 0.04).texture;
      room.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      pmrem.dispose();
    }
    this.scene.environment = g.reflections === 'on' ? this.envTex : null;
    this.fillLight.intensity = g.reflections === 'on' ? 0.9 : 1.25;

    if (g.particles !== 'high') this.motes.visible = false;
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);

    if (this.level && prevDetail && prevDetail !== g.detail) this._rebuildAll();
    else if (shadowsChanged || prevReflections !== g.reflections) {
      // Materials pick up shadow-map / environment changes on recompile.
      this.scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      });
    }
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers and cost. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || '',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px[0] ? px : null),
      pixels: px,
      fps: Math.round(this.fps || 0),
      postFailed: !!this.postFailed,
    };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      document.body.append(el);
    }
    if (el) { el.hidden = !on; if (on && !el.textContent) el.textContent = '… fps'; }
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only emissive gems, lamp glass and bright highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.38, 0.45, 0.92));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  // Detail tier changed: rebuild board, diorama and every item mesh.
  _rebuildAll() {
    this._buildBoard();
    this._buildDiorama();
    for (const [id, mesh] of [...this.meshById]) {
      this.itemGroup.remove(mesh);
      this._disposeItemMesh(mesh);
      this.meshById.delete(id);
    }
    this._syncItems(null);
  }

  setTheme(themeId) {
    this.theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
    this.scene.background = new THREE.Color(this.theme.sky);
    this.scene.fog = new THREE.Fog(this.theme.fog, 14, 30);
    this.keyLight.color.setHex(this.theme.key);
    this.fillLight.color.setHex(this.theme.fill);
    if (this.level) this._buildBoard(); // recolor cells
    this._buildDiorama();
  }

  cellToWorld(cell) {
    const { cols, rows } = this.level;
    const cx = (cell % cols), cz = Math.floor(cell / cols);
    return new THREE.Vector3(
      (cx - (cols - 1) / 2) * CELL,
      0,
      (cz - (rows - 1) / 2) * CELL,
    );
  }

  setLevel(level, state) {
    this.level = level;
    this.state = state;
    this.setTheme(level.theme); // builds board + diorama
    this._syncItems(null);
    this._frameCamera(true);
  }

  _clearGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse?.((o) => {
        if (o.geometry && !this._sharedGeos.has(o.geometry)) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    }
  }

  _disposeItemMesh(mesh) {
    mesh.traverse((o) => {
      if (o.geometry && !this._sharedGeos.has(o.geometry)) o.geometry.dispose();
      if (o.material) o.material.dispose(); // label textures stay in the cache
    });
  }

  _buildBoard() {
    this._clearGroup(this.boardGroup);
    this.cellMeshes = [];
    const { cols, rows } = this.level;
    const d = this.detail;
    const geos = d ? this.geos.detailed : this.geos.plain;
    const baseMat = this._std({ color: this.theme.board, roughness: d ? 0.62 : 0.85, map: d ? woodTexture() : null }, 0.3);
    const felt = d ? feltTexture() : null;
    const cellMatA = this._std({ color: this.theme.cell, roughness: 0.9, map: felt }, 0.15);
    const cellMatB = this._std({ color: this.theme.cellAlt, roughness: 0.9, map: felt }, 0.15);

    const bw = cols * CELL + 0.7, bd = rows * CELL + 0.7;
    const base = new THREE.Mesh(
      d ? new RoundedBoxGeometry(bw, 0.3, bd, 3, 0.06) : new THREE.BoxGeometry(bw, 0.3, bd), baseMat);
    base.position.y = -0.22;
    base.receiveShadow = true;
    base.castShadow = d;
    this.boardGroup.add(base);

    if (d) {
      // Brass inlay rim around the tray: catches the lamp and the room reflections.
      const brass = this._std({ color: 0xb8924e, metalness: 0.9, roughness: 0.4 }, 0.7);
      const t = 0.07;
      for (const [w, dd, x, z] of [
        [bw - 0.12, t, 0, bd / 2 - 0.12], [bw - 0.12, t, 0, -bd / 2 + 0.12],
        [t, bd - 0.12, bw / 2 - 0.12, 0], [t, bd - 0.12, -bw / 2 + 0.12, 0],
      ]) {
        const rim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, dd), brass);
        rim.position.set(x, -0.06, z);
        rim.receiveShadow = true;
        this.boardGroup.add(rim);
      }
    }

    for (let i = 0; i < cols * rows; i++) {
      const cell = new THREE.Mesh(geos.cell, ((i % cols) + Math.floor(i / cols)) % 2 ? cellMatA : cellMatB);
      const p = this.cellToWorld(i);
      cell.position.set(p.x, -0.05, p.z);
      cell.receiveShadow = true;
      cell.userData.cell = i;
      this.boardGroup.add(cell);
      this.cellMeshes.push(cell);
    }
  }

  // Environment diorama: cabinet surround + restoration props that appear
  // with journey progress. Original procedural geometry only.
  _buildDiorama() {
    if (!this.level) return;
    if (this.diorama) { this._clearGroup(this.diorama); this.scene.remove(this.diorama); }
    this.diorama = new THREE.Group();
    this.lamp = null;
    const d = this.detail;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(16, 48),
      this._std({ color: this.theme.board, roughness: d ? 0.8 : 1, map: d ? woodTexture() : null }, 0.2));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.42;
    ground.receiveShadow = true;
    this.diorama.add(ground);

    // Back wall + shelf silhouette of the cabinet.
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(this.level.cols * CELL + 4, 6, 0.4),
      this._std({ color: this.theme.sky, roughness: 0.95, map: d ? panelTexture() : null }, 0.15));
    wall.position.set(0, 2.4, -this.level.rows * CELL / 2 - 2.2);
    wall.receiveShadow = d;
    this.diorama.add(wall);

    // Restoration props: a ring of pedestals + artifacts that fade in with
    // progress. 8 slots; count set by setRestoration().
    this.props = [];
    const propMat = this._std({ color: this.theme.key, roughness: 0.35, metalness: 0.6, emissive: this.theme.key, emissiveIntensity: d ? 0.35 : 0.12 }, 0.9);
    const pedMat = this._std({ color: this.theme.cellAlt, roughness: 0.85, map: d ? woodTexture() : null }, 0.2);
    const r = Math.max(this.level.cols, this.level.rows) * CELL * 0.5 + 2.2;
    this._sceneRadius = r + 0.8;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const g = new THREE.Group();
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 0.8, d ? 20 : 10), pedMat);
      ped.position.y = 0;
      ped.castShadow = d;
      ped.receiveShadow = d;
      const shape = i % 3 === 0
        ? new THREE.IcosahedronGeometry(0.28, 0)
        : i % 3 === 1 ? new THREE.ConeGeometry(0.22, 0.55, 8) : new THREE.TorusKnotGeometry(0.16, 0.06, 64, 10);
      const art = new THREE.Mesh(shape, propMat);
      art.position.y = 0.75;
      art.castShadow = true;
      g.add(ped, art);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      g.visible = false;
      this.diorama.add(g);
      this.props.push({ group: g, art });
    }

    if (d) {
      // A hanging brass lantern behind the tray: warm point light + glowing glass.
      const lx = -(this.level.cols * CELL) * 0.3, lz = -(this.level.rows * CELL) / 2 - 1.1;
      const lamp = new THREE.Group();
      const brass = this._std({ color: 0xb8904a, metalness: 0.9, roughness: 0.35 }, 1.0);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.18, 16), brass);
      cap.position.y = 0.26;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 16), brass);
      base.position.y = -0.2;
      const glass = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14),
        new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc27a, emissiveIntensity: 3.2 }));
      const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 3, 6), brass);
      chain.position.y = 1.85;
      const light = new THREE.PointLight(0xffc27a, 5, 10, 1.6);
      lamp.add(cap, base, glass, chain, light);
      lamp.position.set(lx, 1.7, lz);
      lamp.traverse((o) => { o.raycast = () => {}; });
      this.diorama.add(lamp);
      this.lamp = { group: lamp, light, glass };
    }

    this._applyRestorationVisibility();
    this.scene.add(this.diorama);
    this._fitShadow();
  }

  // Fit the key light's orthographic shadow box tightly around the tray + props.
  _fitShadow() {
    const r = this._sceneRadius || 6;
    const sh = this.keyLight.shadow;
    const dir = new THREE.Vector3(4, 8, 3).normalize();
    this.keyLight.position.copy(dir.multiplyScalar(r + 8));
    this.keyLight.target.position.set(0, 0, 0);
    Object.assign(sh.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 2 * r + 16 });
    sh.camera.updateProjectionMatrix();
  }

  setRestoration(fraction) {
    this.restoration = Math.max(0, Math.min(1, fraction));
    this._applyRestorationVisibility();
  }

  _applyRestorationVisibility() {
    if (!this.props) return;
    const n = Math.round(this.restoration * this.props.length);
    this.props.forEach((p, i) => { p.group.visible = i < n; });
  }

  // --- item meshes ---------------------------------------------------------

  _makeItemMesh(item) {
    const group = new THREE.Group();
    group.userData.id = item.id;
    const d = this.detail;
    const geos = d ? this.geos.detailed : this.geos.plain;
    if (item.kind === 'piece') {
      const hc = this.settings.highContrast;
      const color = new THREE.Color(CHAINS[item.chain].color);
      const mat = d
        ? new THREE.MeshPhysicalMaterial({
          color, roughness: 0.5, metalness: 0.0, clearcoat: 0.55, clearcoatRoughness: 0.22,
          emissive: color, emissiveIntensity: hc ? 0.25 : 0.05,
        })
        : new THREE.MeshStandardMaterial({
          color, roughness: 0.55, metalness: 0.15,
          emissive: color, emissiveIntensity: hc ? 0.25 : 0.08,
        });
      mat.envMapIntensity = 0.22;
      const body = new THREE.Mesh(geos.piece, mat);
      body.castShadow = true;
      body.position.y = PIECE_Y;
      const labelTex = makeLabelTexture(item.chain, item.tier, hc);
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.62, 0.62),
        new THREE.MeshBasicMaterial({ map: labelTex, transparent: false }));
      label.rotation.x = -Math.PI / 2;
      label.position.y = PIECE_Y + 0.205;
      label.raycast = () => {};
      group.add(body, label);
      if (item.webbed) {
        const web = new THREE.Mesh(
          new THREE.PlaneGeometry(0.95, 0.95),
          new THREE.MeshBasicMaterial({ map: makeWebTexture(), transparent: true, opacity: 0.9, depthWrite: false }));
        web.rotation.x = -Math.PI / 2;
        web.position.y = PIECE_Y + 0.24;
        web.raycast = () => {};
        group.add(web);
        group.userData.webbed = true;
      }
    } else if (item.kind === 'generator') {
      const chainColor = new THREE.Color(CHAINS[item.chain].color);
      const mat = this._std({
        color: chainColor.clone().multiplyScalar(0.7),
        roughness: 0.35, metalness: 0.7,
        emissive: chainColor, emissiveIntensity: 0.22,
      }, 0.45);
      const body = new THREE.Mesh(this.genGeo, mat);
      body.castShadow = true;
      body.position.y = PIECE_Y;
      const labelTex = makeLabelTexture(item.chain, 0, this.settings.highContrast);
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.5),
        new THREE.MeshBasicMaterial({ map: labelTex }));
      label.rotation.x = -Math.PI / 2;
      label.position.y = PIECE_Y + 0.18;
      label.raycast = () => {};
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.34, 0.035, 8, 24),
        this._std({ color: 0xd8c890, metalness: 0.8, roughness: 0.3 }, 1.0));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = PIECE_Y + 0.1;
      ring.raycast = () => {};
      const bob = new THREE.Group();
      bob.add(body, label, ring);
      group.add(bob);
      group.userData.spinRing = ring;
      group.userData.bob = bob;
      group.userData.phase = (String(item.id).split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 628) / 100;
      if (d) {
        // Glowing gem band at the foot of the kit: the one piece that blooms.
        const gem = new THREE.Mesh(
          new THREE.TorusGeometry(0.5, 0.028, 8, 40),
          new THREE.MeshStandardMaterial({ color: 0x000000, emissive: chainColor.clone().lerp(new THREE.Color(0xffffff), 0.25), emissiveIntensity: 1.6 }));
        gem.rotation.x = Math.PI / 2;
        gem.position.y = PIECE_Y - 0.13;
        gem.raycast = () => {};
        bob.add(gem);
        group.userData.gem = gem;
      }
    } else if (item.kind === 'crate') {
      const mat = this._std({ color: d ? 0x7a5e40 : 0x5a4632, roughness: 0.95, map: d ? plankTexture() : null }, 0.15);
      const body = new THREE.Mesh(geos.crate, mat);
      body.castShadow = true;
      body.receiveShadow = d;
      body.position.y = 0.18;
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.84, 0.1, 0.84),
        d ? this._std({ color: 0x6b5a44, metalness: 0.7, roughness: 0.45 }, 0.8)
          : this._std({ color: 0x3c2f20, roughness: 0.9 }));
      band.position.y = 0.18;
      band.raycast = () => {};
      group.add(body, band);
    }
    return group;
  }

  _cellOf(id) {
    for (let i = 0; i < this.state.cells.length; i++) {
      if (this.state.cells[i] && this.state.cells[i].id === id) return i;
    }
    return -1;
  }

  // Reconcile visible meshes with the latest snapshot; animate via events.
  syncState(state, events = []) {
    const prev = this.state;
    this.state = state;
    this._syncItems(events);

    if (this.settings.reducedMotion) {
      for (const e of events) {
        if (e.type === 'win') this.burst(new THREE.Vector3(0, 1, 0), 0xffe9a8);
      }
      return;
    }
    for (const e of events) {
      if (e.type === 'spawn' && this.meshById.has(e.item.id)) {
        const m = this.meshById.get(e.item.id);
        m.scale.setScalar(0.01);
        this._tween(0.28, (t) => m.scale.setScalar(easeOut(t)));
      } else if (e.type === 'merge') {
        const p = this.cellToWorld(e.to);
        this.burst(new THREE.Vector3(p.x, 0.7, p.z), 0xffe9a8);
        const m = this.meshById.get(e.item.id);
        if (m) this._tween(0.22, (t) => m.scale.setScalar(1 + Math.sin(t * Math.PI) * 0.35));
      } else if (e.type === 'deliver') {
        const p = this.cellToWorld(e.cell);
        this.burst(new THREE.Vector3(p.x, 0.6, p.z), 0x9fe08a);
      } else if (e.type === 'discover') {
        this.burst(new THREE.Vector3(0, 1.4, 0), 0x8ecfff);
      } else if (e.type === 'win') {
        this.burst(new THREE.Vector3(0, 1, 0), 0xffe9a8);
        this._cameraPulse();
      } else if (e.type === 'lost') {
        this._cameraPulse(0.4);
      }
    }
  }

  _syncItems(events) {
    const seen = new Set();
    for (let i = 0; i < this.state.cells.length; i++) {
      const item = this.state.cells[i];
      if (!item) continue;
      seen.add(item.id);
      let mesh = this.meshById.get(item.id);
      if (!mesh) {
        mesh = this._makeItemMesh(item);
        const p = this.cellToWorld(i);
        mesh.position.set(p.x, 0, p.z);
        this.itemGroup.add(mesh);
        this.meshById.set(item.id, mesh);
      } else {
        // Web state may have changed (unwebbed by merge).
        if (item.kind === 'piece' && !item.webbed && mesh.userData.webbed) {
          const nm = this._makeItemMesh(item);
          nm.position.copy(mesh.position);
          this.itemGroup.remove(mesh);
          this._disposeItemMesh(mesh);
          this.itemGroup.add(nm);
          this.meshById.set(item.id, nm);
          mesh = nm;
        }
        const p = this.cellToWorld(i);
        if (Math.abs(mesh.position.x - p.x) > 0.001 || Math.abs(mesh.position.z - p.z) > 0.001) {
          if (this.settings.reducedMotion) {
            mesh.position.set(p.x, 0, p.z);
          } else {
            const from = mesh.position.clone();
            const to = new THREE.Vector3(p.x, 0, p.z);
            this._tween(0.25, (t) => mesh.position.lerpVectors(from, to, easeInOut(t)));
          }
        }
      }
      mesh.userData.cell = i;
    }
    // Remove vanished meshes (dispose their non-shared resources).
    for (const [id, mesh] of [...this.meshById]) {
      if (!seen.has(id)) {
        this.itemGroup.remove(mesh);
        this._disposeItemMesh(mesh);
        this.meshById.delete(id);
      }
    }
  }

  _tween(dur, update, done) {
    if (this.settings.reducedMotion) { update(1); done?.(); return; }
    this.tweens.push({ t: 0, dur, update, done });
  }

  _cameraPulse(strength = 1) {
    if (this.settings.reducedMotion) return;
    const cam = this.camera;
    const base = cam.position.clone();
    this._tween(0.5, (t) => {
      const k = Math.sin(t * Math.PI * 2) * 0.04 * strength * (1 - t);
      cam.position.set(base.x + k, base.y, base.z + k);
      cam.lookAt(0, 0, 0);
    }, () => this._frameCamera(false));
  }

  shakeCell(cell) {
    if (this.settings.reducedMotion) return;
    const item = this.state.cells[cell];
    const mesh = item && this.meshById.get(item.id);
    const target = mesh || this.cellMeshes[cell];
    if (!target) return;
    const base = target.position.clone();
    this._tween(0.3, (t) => {
      const k = Math.sin(t * Math.PI * 6) * 0.08 * (1 - t);
      target.position.set(base.x + k, base.y, base.z);
    });
  }

  setSelected(cell) {
    this.selected = cell;
    if (cell >= 0 && this.level) {
      const p = this.cellToWorld(cell);
      this.selectRing.position.set(p.x, 0.02, p.z);
      this.selectRing.visible = true;
    } else {
      this.selectRing.visible = false;
    }
  }

  setDragTarget(cell) {
    this.dragTarget = cell;
    if (cell >= 0 && this.level) {
      const p = this.cellToWorld(cell);
      this.targetRing.position.set(p.x, 0.02, p.z);
      this.targetRing.visible = true;
    } else {
      this.targetRing.visible = false;
    }
  }

  setHint(hint) {
    // Merge hints carry from/to rather than a single cell — ring the source.
    const cell = hint ? (hint.cell ?? hint.from) : undefined;
    if (cell !== undefined && this.level) {
      const p = this.cellToWorld(cell);
      this.hintRing.position.set(p.x, 0.02, p.z);
      this.hintRing.visible = true;
    } else {
      this.hintRing.visible = false;
    }
  }

  cellAt(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // Raycast only explicit interaction layers: cells + item bodies.
    const hits = ray.intersectObjects([...this.cellMeshes, ...this.itemGroup.children], true);
    for (const h of hits) {
      let o = h.object;
      while (o) {
        if (o.userData.cell !== undefined) return o.userData.cell;
        o = o.parent;
      }
    }
    return -1;
  }

  _frameCamera(snap) {
    const { cols, rows } = this.level;
    const span = Math.max(cols, rows) * CELL;
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    // Portrait: back off until the tray's full width (plus a margin) fits the
    // horizontal field of view, so narrow phones never crop the outer columns.
    const hHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * aspect);
    const fitWidth = ((span * 0.5 + 0.55) / Math.tan(hHalf) - 2.6) / 1.19;
    const dist = Math.max(span * (aspect < 1 ? 1.5 : 1.18), aspect < 1 ? fitWidth : 0);
    const tilt = this.settings.cameraTilt === 'top' ? 0.35 : 1.0;
    const target = new THREE.Vector3(0, 0, 0);
    const pos = new THREE.Vector3(0, dist * 0.95 * tilt + 2.2, dist * 0.72 + 1.4);
    if (snap || this.settings.reducedMotion) {
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
    } else {
      const from = this.camera.position.clone();
      this._tween(0.6, (t) => {
        this.camera.position.lerpVectors(from, pos, easeInOut(t));
        this.camera.lookAt(target);
      });
    }
  }

  resetCamera() { this._frameCamera(false); }

  resize() {
    if (!this.renderer) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this._syncSize(false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.level) this._frameCamera(true);
  }

  // Pixel ratio = min(dpr, preset cap) × preset/user scale × adaptive scale.
  _syncSize(rescale) {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
  }

  _frame(t) {
    if (this._disposed) return;
    const dtMs = this._lastT ? Math.min(250, t - this._lastT) : 16;
    const dt = Math.min(0.05, dtMs / 1000);
    this._lastT = t;
    const still = this._motionOff();
    if (!still) this._time += dt;
    const time = this._time;

    // Tweens.
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.update(k);
      if (k >= 1) { this.tweens.splice(i, 1); tw.done?.(); }
    }

    // Ambient motion: generator spin + idle bob, hint pulse, prop turn, lamp
    // shimmer. Stops under reduced motion (setting or OS preference).
    if (!still) {
      for (const mesh of this.itemGroup.children) {
        const u = mesh.userData;
        if (u.spinRing) u.spinRing.rotation.z += dt * 0.8;
        if (u.bob) u.bob.position.y = Math.sin(time * 1.6 + (u.phase || 0)) * 0.025 + 0.012;
        if (u.gem) u.gem.material.emissiveIntensity = 1.5 + Math.sin(time * 2.2 + (u.phase || 0)) * 0.3;
      }
      if (this.hintRing.visible) {
        const s = 1 + Math.sin(t / 220) * 0.12;
        this.hintRing.scale.setScalar(s);
      }
      if (this.props) {
        for (const p of this.props) if (p.group.visible) p.art.rotation.y += dt * 0.4;
      }
      if (this.lamp) {
        const f = 1 + Math.sin(time * 7.3) * 0.03 + Math.sin(time * 13.1) * 0.025;
        this.lamp.light.intensity = 5 * f;
        this.lamp.glass.material.emissiveIntensity = 3.2 * f;
        this.lamp.group.rotation.z = Math.sin(time * 0.6) * 0.02;
      }
    } else {
      for (const mesh of this.itemGroup.children) if (mesh.userData.bob) mesh.userData.bob.position.y = 0;
    }

    // Dust motes drift up through the lamplight and wrap around.
    this.motes.visible = this.q.particles === 'high' && !still && !!this.level;
    if (this.motes.visible) {
      const pos = this.motes.geometry.attributes.position;
      for (let i = 0; i < MOTES; i++) {
        const sd = this.moteSeeds[i];
        let y = pos.getY(i) + dt * (0.06 + (sd % 1) * 0.05);
        if (y > 3.6) y = 0.3;
        pos.setXYZ(i,
          pos.getX(i) + Math.sin(time * 0.4 + sd) * dt * 0.08,
          y,
          pos.getZ(i) + Math.cos(time * 0.33 + sd) * dt * 0.08);
      }
      pos.needsUpdate = true;
    }

    // Particles.
    if (this.points.visible) {
      const pos = this.points.geometry.attributes.position;
      let alive = 0;
      for (let i = 0; i < this.particleData.length; i++) {
        const p = this.particleData[i];
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) { pos.setXYZ(i, 0, -100, 0); continue; }
        alive++;
        p.vel.y -= 6 * dt;
        pos.setXYZ(i,
          pos.getX(i) + p.vel.x * dt,
          Math.max(0, pos.getY(i) + p.vel.y * dt),
          pos.getZ(i) + p.vel.z * dt);
      }
      pos.needsUpdate = true;
      this.points.material.opacity = 0.9;
      if (!alive) this.points.visible = false;
    }

    // Adaptive resolution + size sync, then the post chain (rebuilt when its key changes).
    const rescale = this._adapt(dtMs);
    this._syncSize(rescale);
    const [w, h] = this.size;
    if (!w || !h) return;
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try { this.composer.render(dt); } catch { this.postFailed = true; this.composer.dispose(); this.composer = null; this.renderer.render(this.scene, this.camera); }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  setPaused(paused) {
    // Rendering to zero heartbeat while hidden: stop the loop entirely.
    if (paused) this.renderer.setAnimationLoop(null);
    else { this._lastT = null; this.renderer.setAnimationLoop((t) => this._frame(t)); }
  }

  dispose() {
    this._disposed = true;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this.renderer.setAnimationLoop(null);
    this.composer?.dispose();
    this.composer = null;
    this._clearGroup(this.itemGroup);
    this._clearGroup(this.boardGroup);
    if (this.diorama) this._clearGroup(this.diorama);
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.motes.geometry.dispose();
    this.motes.material.dispose();
    this.envTex?.dispose();
    for (const g of this._sharedGeos) g.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    const fps = document.getElementById('fps-meter');
    if (fps) fps.hidden = true;
  }
}
