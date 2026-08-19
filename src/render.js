// Three.js presentation layer. Consumes immutable rules snapshots + event
// lists; never mutates game state. Board is a tabletop diorama in an
// explorer's cabinet: authored camera, PBR lighting, pooled particles,
// semantic meshes per entity kind, explicit disposal, quality tiers.

import * as THREE from '../vendor/three.module.js';
import { CHAINS, itemIcon, THEMES } from './content.js';

const CELL = 1.15;
const PIECE_Y = 0.22;

const QUALITY = {
  low: { dpr: 1, shadows: false, particles: false, antialias: false },
  medium: { dpr: 1.5, shadows: true, particles: true, antialias: true },
  high: { dpr: 2, shadows: true, particles: true, antialias: true },
};

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
  // opts: { settings, onFpsSample(tier suggestion) }
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
    this._fpsAccum = 0; this._fpsFrames = 0; this._autoTier = 'high';
    this._disposed = false;
  }

  init() {
    let canvas;
    try {
      canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return false;
    } catch { return false; }

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('gl-canvas');

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    this.keyLight.position.set(4, 8, 3);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.keyLight);
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

    // Shared geometries/materials.
    this.pieceGeo = new THREE.BoxGeometry(0.72, 0.4, 0.72);
    this.genGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.34, 24);
    this.crateGeo = new THREE.BoxGeometry(0.8, 0.62, 0.8);
    this.cellGeo = new THREE.BoxGeometry(1.02, 0.14, 1.02);
    this._sharedGeos = new Set([this.pieceGeo, this.genGeo, this.crateGeo, this.cellGeo]);

    // Particle pool (bounded; one Points cloud reused for bursts).
    this._initParticles();

    this.applyQuality(this.settings.quality || 'auto');
    this.resize();
    this.renderer.setAnimationLoop((t) => this._frame(t));
    return true;
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

  burst(worldPos, color = 0xffe9a8) {
    if (!this.quality.particles || this.settings.reducedMotion) return;
    this.points.material.color.setHex(color);
    this.points.visible = true;
    const pos = this.points.geometry.attributes.position;
    let n = 0;
    for (const p of this.particleData) {
      if (p.life <= 0 && n < 40) {
        p.life = 0.55 + Math.random() * 0.25;
        p.maxLife = p.life;
        p.vel.set((Math.random() - 0.5) * 3, 2 + Math.random() * 2.2, (Math.random() - 0.5) * 3);
        pos.setXYZ(n, worldPos.x, worldPos.y, worldPos.z);
        n++;
      }
    }
    pos.needsUpdate = true;
  }

  applyQuality(q) {
    const tier = q === 'auto' ? this._autoTier : q;
    this.quality = QUALITY[tier] || QUALITY.high;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.dpr);
    this.renderer.setPixelRatio(dpr);
    this.keyLight.castShadow = this.quality.shadows;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    if (!this.quality.particles) this.points.visible = false;
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
    const baseMat = new THREE.MeshStandardMaterial({ color: this.theme.board, roughness: 0.85 });
    const cellMatA = new THREE.MeshStandardMaterial({ color: this.theme.cell, roughness: 0.9 });
    const cellMatB = new THREE.MeshStandardMaterial({ color: this.theme.cellAlt, roughness: 0.9 });

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(cols * CELL + 0.7, 0.3, rows * CELL + 0.7), baseMat);
    base.position.y = -0.22;
    base.receiveShadow = true;
    this.boardGroup.add(base);

    for (let i = 0; i < cols * rows; i++) {
      const cell = new THREE.Mesh(this.cellGeo, ((i % cols) + Math.floor(i / cols)) % 2 ? cellMatA : cellMatB);
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
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(16, 40),
      new THREE.MeshStandardMaterial({ color: this.theme.board, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.42;
    ground.receiveShadow = true;
    this.diorama.add(ground);

    // Back wall + shelf silhouette of the cabinet.
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(this.level.cols * CELL + 4, 6, 0.4),
      new THREE.MeshStandardMaterial({ color: this.theme.sky, roughness: 0.95 }));
    wall.position.set(0, 2.4, -this.level.rows * CELL / 2 - 2.2);
    this.diorama.add(wall);

    // Restoration props: a ring of pedestals + artifacts that fade in with
    // progress. 8 slots; count set by setRestoration().
    this.props = [];
    const propMat = new THREE.MeshStandardMaterial({ color: this.theme.key, roughness: 0.5, metalness: 0.4, emissive: this.theme.key, emissiveIntensity: 0.12 });
    const pedMat = new THREE.MeshStandardMaterial({ color: this.theme.cellAlt, roughness: 0.85 });
    const r = Math.max(this.level.cols, this.level.rows) * CELL * 0.5 + 2.2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const g = new THREE.Group();
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 0.8, 10), pedMat);
      ped.position.y = 0;
      const shape = i % 3 === 0
        ? new THREE.IcosahedronGeometry(0.28, 0)
        : i % 3 === 1 ? new THREE.ConeGeometry(0.22, 0.55, 8) : new THREE.TorusKnotGeometry(0.16, 0.06, 48, 8);
      const art = new THREE.Mesh(shape, propMat);
      art.position.y = 0.75;
      art.castShadow = true;
      g.add(ped, art);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      g.visible = false;
      this.diorama.add(g);
      this.props.push({ group: g, art });
    }
    this._applyRestorationVisibility();
    this.scene.add(this.diorama);
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
    if (item.kind === 'piece') {
      const hc = this.settings.highContrast;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(CHAINS[item.chain].color),
        roughness: 0.55, metalness: 0.15,
        emissive: new THREE.Color(CHAINS[item.chain].color), emissiveIntensity: hc ? 0.25 : 0.08,
      });
      const body = new THREE.Mesh(this.pieceGeo, mat);
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
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(CHAINS[item.chain].color).multiplyScalar(0.7),
        roughness: 0.35, metalness: 0.7,
        emissive: new THREE.Color(CHAINS[item.chain].color), emissiveIntensity: 0.3,
      });
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
        new THREE.MeshStandardMaterial({ color: 0xd8c890, metalness: 0.8, roughness: 0.3 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = PIECE_Y + 0.1;
      ring.raycast = () => {};
      group.add(body, label, ring);
      group.userData.spinRing = ring;
    } else if (item.kind === 'crate') {
      const mat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });
      const body = new THREE.Mesh(this.crateGeo, mat);
      body.castShadow = true;
      body.position.y = 0.18;
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.84, 0.1, 0.84),
        new THREE.MeshStandardMaterial({ color: 0x3c2f20, roughness: 0.9 }));
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
    if (hint && hint.cell !== undefined) {
      const p = this.cellToWorld(hint.cell ?? hint.from);
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
    const dist = span * (aspect < 1 ? 1.5 : 1.18);
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
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.level) this._frameCamera(true);
  }

  _frame(t) {
    if (this._disposed) return;
    const dt = Math.min(0.05, this._lastT ? (t - this._lastT) / 1000 : 0.016);
    this._lastT = t;

    // Tweens.
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.update(k);
      if (k >= 1) { this.tweens.splice(i, 1); tw.done?.(); }
    }

    // Generator ring spin (decorative, reduced-motion safe).
    if (!this.settings.reducedMotion) {
      for (const mesh of this.itemGroup.children) {
        if (mesh.userData.spinRing) mesh.userData.spinRing.rotation.z += dt * 0.8;
      }
      // Gentle hint pulse.
      if (this.hintRing.visible) {
        const s = 1 + Math.sin(t / 220) * 0.12;
        this.hintRing.scale.setScalar(s);
      }
      if (this.props) {
        for (const p of this.props) if (p.group.visible) p.art.rotation.y += dt * 0.4;
      }
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

    // FPS sampling → auto quality tier.
    this._fpsAccum += dt; this._fpsFrames++;
    if (this._fpsAccum >= 2) {
      const fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0; this._fpsFrames = 0;
      if ((this.settings.quality || 'auto') === 'auto') {
        const next = fps < 28 ? 'low' : fps < 48 ? 'medium' : 'high';
        if (next !== this._autoTier) { this._autoTier = next; this.applyQuality('auto'); }
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  setPaused(paused) {
    // Rendering to zero heartbeat while hidden: stop the loop entirely.
    if (paused) this.renderer.setAnimationLoop(null);
    else { this._lastT = null; this.renderer.setAnimationLoop((t) => this._frame(t)); }
  }

  dispose() {
    this._disposed = true;
    this.renderer.setAnimationLoop(null);
    this._clearGroup(this.itemGroup);
    this._clearGroup(this.boardGroup);
    if (this.diorama) this._clearGroup(this.diorama);
    this.points.geometry.dispose();
    this.points.material.dispose();
    for (const g of this._sharedGeos) g.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
