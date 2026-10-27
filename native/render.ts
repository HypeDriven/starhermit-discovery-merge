// The explorer's cabinet on starhermit:scene, as the browser build's
// src/render.js drew it: a tabletop tray of felt cells on a wooden base (a
// brass inlay rim on the detailed looks), item pieces as rounded tiles in
// their chain's colour with a label tile on top (the item's icon and its tier
// pips), Field Kits as spinning, bobbing brass drums with a glowing gem band,
// crates with metal bands, cobwebs over webbed pieces, the selection / drag
// target / hint rings, the cabinet's back wall and floor, the restoration
// pedestals that appear with Journey progress, the hanging lantern with its
// flickering point light, pooled spark bursts and drifting dust motes, the
// authored camera (top-down tilt option, the win/lose pulse) and the shake of
// a refused move.
//
// Gaps and changes from three.js: light intensities are three.js's ÷ π (the
// engine's convention); the post chain is renderer.ao / bloom / grade /
// antialias (the grade the browser build's GradeShader in display space);
// the label tiles draw the item icons from assets/icons.png (the engine's
// canvas has no colour emoji font); tweens run on the runtime's fixed steps
// (tick) instead of the animation frame, so a round plays the same in every
// run; the shadow is fitted by distance (the engine's directional shadow
// fits the view, three.js fitted an orthographic box); adaptive resolution,
// the frame-rate meter and the pixel-ratio cap are the runtime's. The
// camera is fitted to the playfield the HUD leaves (setViewOffset), as the
// browser build's canvas sat between its rails.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, IcosahedronGeometry,
  Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, PlaneGeometry,
  PMREMGenerator, PointLight, Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, RoundedBoxGeometry,
  SphereGeometry, SRGBColorSpace, TorusGeometry, TorusKnotGeometry, Vector3, pointerToNdc, renderer, scene,
  type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { CHAINS, THEMES, itemIcon } from "../src/content.js";
import { CELL as ICON_PX, iconAtlas, iconIndex, iconRect, whenIcons } from "./icons.ts";
import type { Look } from "./quality.ts";

const PI = Math.PI;
const CELL = 1.15;
const PIECE_Y = 0.22;
const MOTES = 90;

export interface Item { id: string; kind: "piece" | "generator" | "crate"; chain?: string; tier?: number; webbed?: boolean }
export interface BoardState { cells: (Item | null)[] }
export interface LevelLike { cols: number; rows: number; theme: string }
export interface RulesEvent { type: string; item?: Item; to?: number; cell?: number; unwebbed?: boolean }
type Theme = (typeof THEMES)[number];

// -- renderer and camera (src/render.js init) -----------------------------------------------
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
const camera = new PerspectiveCamera(38, 1, 0.1, 100);

let look: Look | null = null;
let reducedMotion = false;
let highContrast = false;
let cameraTilt = "default";
let theme: Theme = THEMES[0]!;
let level: LevelLike | null = null;
let state: BoardState | null = null;

const keyLight = new DirectionalLight(0xffffff, 2.6 / PI);
keyLight.position.set(4, 8, 3);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);
scene.add(keyLight.target);
const fillLight = new HemisphereLight(0xffffff, 0x223311, 1.25 / PI);
scene.add(fillLight);

const boardGroup = new Group();
const itemGroup = new Group();
const fxGroup = new Group();
scene.add(boardGroup);
scene.add(itemGroup);
scene.add(fxGroup);
let diorama: Group | null = null;

// Selection ring + drag-target ghost + hint ring (grounded markers).
function ring(color: number, opacity: number): Mesh<MeshBasicMaterial> {
  const m = new Mesh(new RingGeometry(0.42, 0.55, 32), new MeshBasicMaterial({ color, side: DoubleSide, transparent: true, opacity }));
  m.rotation.x = -PI / 2;
  m.visible = false;
  scene.add(m);
  return m;
}
const selectRing = ring(0xfff2b0, 0.95);
const targetRing = ring(0x9fe08a, 0.9);
const hintRing = ring(0x8ecfff, 0.85);

let envTex: Texture | null = null;
function envMap(): Texture | null {
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}

// -- procedural surface textures (detailed looks) ------------------------------------------
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Ctx = OffscreenCanvasRenderingContext2D;
const texCache = new Map<string, Texture>();
function canvasTex(key: string, size: number, paint: (g: Ctx, n: number) => void, repeat = 1): Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = new OffscreenCanvas(size, size);
  paint(c.getContext("2d")!, size);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  texCache.set(key, tex);
  return tex;
}
/** Walnut grain: light base (the material colour tints it), wavy darker streaks. */
function woodTexture(): Texture {
  return canvasTex("wood", 256, (g, n) => {
    const rnd = seeded(7);
    g.fillStyle = "#f2ece4";
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
/** Felt: near-white speckle so each cell keeps its theme colour. */
function feltTexture(): Texture {
  return canvasTex("felt", 128, (g, n) => {
    const img = g.createImageData(n, n);
    const rnd = seeded(11);
    for (let i = 0; i < n * n; i++) {
      const v = 226 + rnd() * 29;
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}
/** Cabinet back wall: vertical panels with grooves and a faint grain. */
function panelTexture(): Texture {
  return canvasTex("panel", 256, (g, n) => {
    const rnd = seeded(23);
    g.fillStyle = "#e8e2da";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 120; i++) {
      g.fillStyle = `rgba(80,60,40,${rnd() * 0.06})`;
      g.fillRect(rnd() * n, 0, 1 + rnd() * 2, n);
    }
    for (let x = 0; x < n; x += n / 4) {
      g.fillStyle = "rgba(40,28,18,0.45)";
      g.fillRect(x, 0, 3, n);
      g.fillStyle = "rgba(255,255,255,0.12)";
      g.fillRect(x + 3, 0, 2, n);
    }
  });
}
/** Crate planks. */
function plankTexture(): Texture {
  return canvasTex("plank", 128, (g, n) => {
    const rnd = seeded(31);
    g.fillStyle = "#d8c8b4";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(70,45,25,${0.08 + rnd() * 0.12})`;
      g.lineWidth = 1;
      const y = rnd() * n;
      g.beginPath(); g.moveTo(0, y); g.lineTo(n, y + (rnd() - 0.5) * 6); g.stroke();
    }
    for (let y = 0; y < n; y += n / 4) {
      g.fillStyle = "rgba(30,20,10,0.55)";
      g.fillRect(0, y, n, 2);
    }
  });
}
/** Soft round sprite for the motes. */
function dotTexture(): Texture {
  return canvasTex("dot", 64, (g, n) => {
    const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.4, "rgba(255,255,255,0.6)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
  });
}

/** Label tile: chain-coloured rounded square, the item's icon, tier pips (shape reinforces the number). */
const labelCache = new Map<string, Texture>();
function labelTexture(chain: string, tier: number, hc: boolean): Texture {
  const key = `${chain}:${tier}:${hc ? 1 : 0}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = new OffscreenCanvas(128, 128);
  const g = c.getContext("2d")!;
  const info = (CHAINS as Record<string, { color: string }>)[chain];
  g.fillStyle = hc ? "#141414" : (info ? info.color : "#888888");
  g.beginPath();
  g.roundRect(4, 4, 120, 120, 22);
  g.fill();
  g.strokeStyle = hc ? "#ffffff" : "rgba(255,255,255,0.35)";
  g.lineWidth = 5;
  g.stroke();
  g.fillStyle = hc ? "#ffffff" : "rgba(255,255,255,0.85)";
  for (let i = 0; i <= tier; i++) {
    g.beginPath();
    g.arc(64 + (i - tier / 2) * 14, 106, 4.4, 0, PI * 2);
    g.fill();
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  labelCache.set(key, tex);
  // The icon (src/render.js filled the emoji at 58 px, centred a little high).
  whenIcons(() => {
    const atlas = iconAtlas();
    const i = iconIndex(itemIcon(chain, tier));
    if (!atlas || i < 0) return;
    const s = iconRect(i);
    g.drawImage(atlas, s.x, s.y, ICON_PX, ICON_PX, 64 - 33, 58 - 33, 66, 66);
    tex.needsUpdate = true;
  });
  return tex;
}
function webTexture(): Texture {
  return canvasTex("web", 128, (g) => {
    g.strokeStyle = "rgba(235,235,245,0.9)";
    g.lineWidth = 2.5;
    const cx = 64, cy = 64;
    for (let a = 0; a < 8; a++) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a * PI / 4) * 62, cy + Math.sin(a * PI / 4) * 62);
      g.stroke();
    }
    for (let r = 16; r <= 56; r += 14) {
      g.beginPath();
      for (let a = 0; a <= 8; a++) {
        const wob = r + Math.sin(a * 2.3) * 3;
        const x = cx + Math.cos(a * PI / 4) * wob, y = cy + Math.sin(a * PI / 4) * wob;
        if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
  });
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// -- shared geometries (plain boxes, or rounded per the look's segments) ----------------------
interface GeoSet { piece: BufferGeometry; cell: BufferGeometry; crate: BufferGeometry }
let geos: { plain: GeoSet; detailed: GeoSet } | null = null;
let geoSegs = -1;
const genGeo = new CylinderGeometry(0.42, 0.52, 0.34, 32);
const shared = new Set<BufferGeometry>([genGeo]);
function makeGeos(): void {
  const n = look ? look.budget.pieceSegs : 1;
  if (geos && geoSegs === n) return;
  if (geos) for (const set of [geos.plain, geos.detailed]) for (const g of Object.values(set)) { shared.delete(g); g.dispose(); }
  geos = {
    plain: { piece: new BoxGeometry(0.72, 0.4, 0.72), cell: new BoxGeometry(1.02, 0.14, 1.02), crate: new BoxGeometry(0.8, 0.62, 0.8) },
    detailed: {
      piece: new RoundedBoxGeometry(0.72, 0.4, 0.72, n, 0.09),
      cell: new RoundedBoxGeometry(1.02, 0.14, 1.02, Math.max(1, Math.round(n / 2)), 0.045),
      crate: new RoundedBoxGeometry(0.8, 0.62, 0.8, Math.max(1, Math.round(n / 2)), 0.04),
    },
  };
  for (const set of [geos.plain, geos.detailed]) for (const g of Object.values(set)) shared.add(g);
  geoSegs = n;
}
const detail = (): boolean => !!look && look.detailed;
const geoSet = (): GeoSet => { makeGeos(); return detail() ? geos!.detailed : geos!.plain; };

interface LitParams {
  color: number | Color; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number;
  emissive?: number | Color; emissiveIntensity?: number; map?: Texture | null;
}
/** Lit material in the look's class (src/render.js _std): Lambert on Low, standard on Balanced,
 * clear-coated physical on High/Ultra where asked; a restrained environment reflection. */
function std(p: LitParams, env = 0.35, physical = false): Material {
  const kind = look ? look.budget.material : "lambert";
  const base = { color: p.color, map: p.map ?? null, ...(p.emissive !== undefined ? { emissive: p.emissive, emissiveIntensity: p.emissiveIntensity ?? 1 } : {}) };
  if (kind === "lambert") return new MeshLambertMaterial(base);
  const sp = { ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0, envMapIntensity: env };
  if (kind === "physical" && physical) return new MeshPhysicalMaterial({ ...sp, clearcoat: p.clearcoat ?? 0, clearcoatRoughness: p.clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(sp);
}

function disposeTree(o: Object3D): void {
  o.traverse((ch) => {
    const m = ch as Mesh;
    if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
    const mat = (m as { material?: Material | Material[] }).material;
    if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose(); // textures stay in their caches
  });
}
function clearGroup(g: Group): void {
  while (g.children.length) { const ch = g.children[g.children.length - 1]!; g.remove(ch); disposeTree(ch); }
}

const cellToWorld = (cell: number): Vector3 => {
  const { cols, rows } = level!;
  return new Vector3((cell % cols - (cols - 1) / 2) * CELL, 0, (Math.floor(cell / cols) - (rows - 1) / 2) * CELL);
};

// -- the board and the cabinet -------------------------------------------------------------------
let cellMeshes: Mesh[] = [];
function buildBoard(): void {
  clearGroup(boardGroup);
  cellMeshes = [];
  if (!level) return;
  const { cols, rows } = level;
  const d = detail();
  const g = geoSet();
  const baseMat = std({ color: theme.board, roughness: d ? 0.62 : 0.85, map: d ? woodTexture() : null }, 0.3);
  const felt = d ? feltTexture() : null;
  const cellA = std({ color: theme.cell, roughness: 0.9, map: felt }, 0.15);
  const cellB = std({ color: theme.cellAlt, roughness: 0.9, map: felt }, 0.15);
  const bw = cols * CELL + 0.7, bd = rows * CELL + 0.7;
  const base = new Mesh(d ? new RoundedBoxGeometry(bw, 0.3, bd, 3, 0.06) : new BoxGeometry(bw, 0.3, bd), baseMat);
  base.position.y = -0.22;
  base.receiveShadow = true;
  base.castShadow = d;
  boardGroup.add(base);
  if (d) {
    // Brass inlay rim around the tray: catches the lamp and the room reflections.
    const brass = std({ color: 0xb8924e, metalness: 0.9, roughness: 0.4 }, 0.7);
    const t = 0.07;
    for (const [w, dd, x, z] of [[bw - 0.12, t, 0, bd / 2 - 0.12], [bw - 0.12, t, 0, -bd / 2 + 0.12], [t, bd - 0.12, bw / 2 - 0.12, 0], [t, bd - 0.12, -bw / 2 + 0.12, 0]] as const) {
      const rim = new Mesh(new BoxGeometry(w, 0.04, dd), brass);
      rim.position.set(x, -0.06, z);
      rim.receiveShadow = true;
      boardGroup.add(rim);
    }
  }
  for (let i = 0; i < cols * rows; i++) {
    const cell = new Mesh(g.cell, ((i % cols) + Math.floor(i / cols)) % 2 ? cellA : cellB);
    const p = cellToWorld(i);
    cell.position.set(p.x, -0.05, p.z);
    cell.receiveShadow = true;
    cell.userData = { cell: i };
    boardGroup.add(cell);
    cellMeshes.push(cell);
  }
}

let props: { group: Group; art: Mesh }[] = [];
let lamp: { group: Group; light: PointLight; glass: Mesh<MeshStandardMaterial> } | null = null;
let restoration = 0;
let sceneRadius = 6;
/** The cabinet surround, the restoration pedestals (shown with Journey progress) and the lantern. */
function buildDiorama(): void {
  if (diorama) { clearGroup(diorama); scene.remove(diorama); diorama = null; }
  lamp = null;
  props = [];
  if (!level || !look) return;
  const dio = new Group();
  const d = detail();
  const ground = new Mesh(new CircleGeometry(16, 48), std({ color: theme.board, roughness: d ? 0.8 : 1, map: d ? woodTexture() : null }, 0.2));
  ground.rotation.x = -PI / 2;
  ground.position.y = -0.42;
  ground.receiveShadow = true;
  dio.add(ground);
  // Back wall of the cabinet.
  const wall = new Mesh(new BoxGeometry(level.cols * CELL + 4, 6, 0.4), std({ color: theme.sky, roughness: 0.95, map: d ? panelTexture() : null }, 0.15));
  wall.position.set(0, 2.4, -level.rows * CELL / 2 - 2.2);
  wall.receiveShadow = d;
  dio.add(wall);
  // Eight pedestals with artefacts round the tray; restoration shows a share of them.
  const propMat = std({ color: theme.key, roughness: 0.35, metalness: 0.6, emissive: theme.key, emissiveIntensity: d ? 0.35 : 0.12 }, 0.9);
  const pedMat = std({ color: theme.cellAlt, roughness: 0.85, map: d ? woodTexture() : null }, 0.2);
  const r = Math.max(level.cols, level.rows) * CELL * 0.5 + 2.2;
  sceneRadius = r + 0.8;
  const ps = look.budget.propSegs;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2 + PI / 8;
    const g = new Group();
    const ped = new Mesh(new CylinderGeometry(0.3, 0.4, 0.8, d ? ps : Math.min(10, ps)), pedMat);
    ped.castShadow = d;
    ped.receiveShadow = d;
    const shape = i % 3 === 0 ? new IcosahedronGeometry(0.28, 0)
      : i % 3 === 1 ? new ConeGeometry(0.22, 0.55, 8) : new TorusKnotGeometry(0.16, 0.06, ps * 3, Math.max(6, Math.round(ps / 2)));
    const art = new Mesh(shape, propMat);
    art.position.y = 0.75;
    art.castShadow = true;
    g.add(ped);
    g.add(art);
    g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    g.visible = false;
    dio.add(g);
    props.push({ group: g, art });
  }
  if (d) {
    // A hanging brass lantern behind the tray: a warm point light and glowing glass.
    const lx = -(level.cols * CELL) * 0.3, lz = -(level.rows * CELL) / 2 - 1.1;
    const lg = new Group();
    const brass = std({ color: 0xb8904a, metalness: 0.9, roughness: 0.35 }, 1.0);
    const cap = new Mesh(new ConeGeometry(0.22, 0.18, 16), brass);
    cap.position.y = 0.26;
    const base = new Mesh(new CylinderGeometry(0.16, 0.2, 0.06, 16), brass);
    base.position.y = -0.2;
    const glass = new Mesh(new SphereGeometry(0.15, 20, 14), new MeshStandardMaterial({ color: 0x000000, emissive: 0xffc27a, emissiveIntensity: 3.2 }));
    const chain = new Mesh(new CylinderGeometry(0.012, 0.012, 3, 6), brass);
    chain.position.y = 1.85;
    const light = new PointLight(0xffc27a, 5 / PI, 10, 1.6);
    for (const o of [cap, base, glass, chain, light]) lg.add(o);
    lg.position.set(lx, 1.7, lz);
    dio.add(lg);
    lamp = { group: lg, light, glass };
  }
  applyRestoration();
  scene.add(dio);
  diorama = dio;
  fitShadow();
}
function applyRestoration(): void {
  const n = Math.round(restoration * props.length);
  props.forEach((p, i) => { p.group.visible = i < n; });
}
/** The engine fits the directional shadow to the view out to `distance` (three.js fitted its ortho box to the tray and props). */
function fitShadow(): void {
  const r = sceneRadius;
  const dir = new Vector3(4, 8, 3).normalize();
  keyLight.position.copy(dir.multiplyScalar(r + 8));
  keyLight.target.position.set(0, 0, 0);
  keyLight.shadow.distance = 2 * r + 16;
}

// -- item meshes ---------------------------------------------------------------------------------
interface ItemMesh { group: Group; cell: number; webbed: boolean; spinRing?: Mesh; bob?: Group; gem?: Mesh<MeshStandardMaterial>; phase: number }
const meshById = new Map<string, ItemMesh>();
function makeItemMesh(item: Item): ItemMesh {
  const group = new Group();
  const d = detail();
  const g = geoSet();
  const out: ItemMesh = { group, cell: -1, webbed: false, phase: 0 };
  if (item.kind === "piece") {
    const color = new Color((CHAINS as Record<string, { color: string }>)[item.chain!]!.color);
    const mat = d
      ? std({ color, roughness: 0.5, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.22, emissive: color, emissiveIntensity: highContrast ? 0.25 : 0.05 }, 0.22, true)
      : std({ color, roughness: 0.55, metalness: 0.15, emissive: color, emissiveIntensity: highContrast ? 0.25 : 0.08 }, 0.22);
    const body = new Mesh(g.piece, mat);
    body.castShadow = true;
    body.position.y = PIECE_Y;
    const label = new Mesh(new PlaneGeometry(0.62, 0.62), new MeshBasicMaterial({ map: labelTexture(item.chain!, item.tier!, highContrast) }));
    label.rotation.x = -PI / 2;
    label.position.y = PIECE_Y + 0.205;
    group.add(body);
    group.add(label);
    if (item.webbed) {
      const web = new Mesh(new PlaneGeometry(0.95, 0.95), new MeshBasicMaterial({ map: webTexture(), transparent: true, opacity: 0.9, depthWrite: false }));
      web.rotation.x = -PI / 2;
      web.position.y = PIECE_Y + 0.24;
      group.add(web);
      out.webbed = true;
    }
  } else if (item.kind === "generator") {
    const chainColor = new Color((CHAINS as Record<string, { color: string }>)[item.chain!]!.color);
    const body = new Mesh(genGeo, std({ color: chainColor.clone().multiplyScalar(0.7), roughness: 0.35, metalness: 0.7, emissive: chainColor, emissiveIntensity: 0.22 }, 0.45));
    body.castShadow = true;
    body.position.y = PIECE_Y;
    const label = new Mesh(new PlaneGeometry(0.5, 0.5), new MeshBasicMaterial({ map: labelTexture(item.chain!, 0, highContrast) }));
    label.rotation.x = -PI / 2;
    label.position.y = PIECE_Y + 0.18;
    const spin = new Mesh(new TorusGeometry(0.34, 0.035, 8, 24), std({ color: 0xd8c890, metalness: 0.8, roughness: 0.3 }, 1.0));
    spin.rotation.x = PI / 2;
    spin.position.y = PIECE_Y + 0.1;
    const bob = new Group();
    bob.add(body);
    bob.add(label);
    bob.add(spin);
    group.add(bob);
    out.spinRing = spin;
    out.bob = bob;
    out.phase = (String(item.id).split("").reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 628) / 100;
    if (d) {
      // Glowing gem band at the foot of the kit: the one piece that blooms.
      const gem = new Mesh(new TorusGeometry(0.5, 0.028, 8, 40),
        new MeshStandardMaterial({ color: 0x000000, emissive: chainColor.clone().lerp(new Color(0xffffff), 0.25), emissiveIntensity: 1.6 }));
      gem.rotation.x = PI / 2;
      gem.position.y = PIECE_Y - 0.13;
      bob.add(gem);
      out.gem = gem;
    }
  } else {
    const body = new Mesh(g.crate, std({ color: d ? 0x7a5e40 : 0x5a4632, roughness: 0.95, map: d ? plankTexture() : null }, 0.15));
    body.castShadow = true;
    body.receiveShadow = d;
    body.position.y = 0.18;
    const band = new Mesh(new BoxGeometry(0.84, 0.1, 0.84),
      d ? std({ color: 0x6b5a44, metalness: 0.7, roughness: 0.45 }, 0.8) : std({ color: 0x3c2f20, roughness: 0.9 }));
    band.position.y = 0.18;
    group.add(body);
    group.add(band);
  }
  return out;
}
function dropItem(id: string): void {
  const m = meshById.get(id);
  if (!m) return;
  itemGroup.remove(m.group);
  disposeTree(m.group);
  meshById.delete(id);
}
/** Reconciles the item meshes with a state (src/render.js _syncItems): new ones appear, moved ones glide, gone ones go. */
function syncItems(): void {
  if (!state || !level) return;
  const seen = new Set<string>();
  state.cells.forEach((item, i) => {
    if (!item) return;
    seen.add(item.id);
    let m = meshById.get(item.id);
    if (!m) {
      m = makeItemMesh(item);
      const p = cellToWorld(i);
      m.group.position.set(p.x, 0, p.z);
      itemGroup.add(m.group);
      meshById.set(item.id, m);
    } else {
      if (item.kind === "piece" && !item.webbed && m.webbed) {
        // Unwebbed by a merge: the same piece without its cobweb.
        const nm = makeItemMesh(item);
        nm.group.position.copy(m.group.position);
        dropItem(item.id);
        itemGroup.add(nm.group);
        meshById.set(item.id, nm);
        m = nm;
      }
      const p = cellToWorld(i);
      const g = m.group;
      if (Math.abs(g.position.x - p.x) > 0.001 || Math.abs(g.position.z - p.z) > 0.001) {
        if (reducedMotion) g.position.set(p.x, 0, p.z);
        else {
          const from = g.position.clone(), to = new Vector3(p.x, 0, p.z);
          tween(0.25, (t) => g.position.copy(from).lerp(to, easeInOut(t)));
        }
      }
    }
    m.cell = i;
  });
  for (const id of [...meshById.keys()]) if (!seen.has(id)) dropItem(id);
}
function rebuildAll(): void {
  buildBoard();
  buildDiorama();
  for (const id of [...meshById.keys()]) dropItem(id);
  syncItems();
}

// -- particles and motes -----------------------------------------------------------------------
const P_CAP = 240;
const pGeo = new BufferGeometry();
const pPos = new Float32Array(P_CAP * 3);
const pVel = new Float32Array(P_CAP * 3), pLife = new Float32Array(P_CAP);
for (let i = 0; i < P_CAP; i++) pPos[i * 3 + 1] = -100;
pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
const pMat = new PointsMaterial({ color: 0xffe9a8, size: 0.07, transparent: true, opacity: 0.9, depthWrite: false });
const points = new Points(pGeo, pMat);
points.frustumCulled = false;
points.visible = false;
fxGroup.add(points);

const motePos = new Float32Array(MOTES * 3);
const moteSeeds: number[] = [];
{
  const rnd = seeded(97);
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = (rnd() - 0.5) * 9;
    motePos[i * 3 + 1] = 0.3 + rnd() * 3.2;
    motePos[i * 3 + 2] = (rnd() - 0.5) * 9;
    moteSeeds.push(rnd() * 100);
  }
}
const moteGeo = new BufferGeometry();
moteGeo.setAttribute("position", new BufferAttribute(motePos, 3));
const motes = new Points(moteGeo, new PointsMaterial({ color: 0xffe2b0, size: 0.06, map: dotTexture(), transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }));
motes.frustumCulled = false;
motes.visible = false;
fxGroup.add(motes);

function burst(at: Vector3, color = 0xffe9a8): void {
  if (reducedMotion || !look) return;
  const b = look.budget.burst;
  const cap = look.particlesHigh ? b : Math.min(18, b);
  pMat.color.set(color);
  pMat.size = look.particlesHigh ? 0.08 : 0.07;
  points.visible = true;
  let n = 0;
  for (let i = 0; i < P_CAP && n < cap; i++) {
    if (pLife[i]! > 0) continue;
    pLife[i] = 0.55 + Math.random() * 0.25;
    pVel[i * 3] = (Math.random() - 0.5) * 3;
    pVel[i * 3 + 1] = 2 + Math.random() * 2.2;
    pVel[i * 3 + 2] = (Math.random() - 0.5) * 3;
    pPos[i * 3] = at.x; pPos[i * 3 + 1] = at.y; pPos[i * 3 + 2] = at.z;
    n++;
  }
  (pGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
}

// -- tweens (fixed steps) ----------------------------------------------------------------------
interface Tween { t: number; dur: number; update: (k: number) => void; done?: () => void }
let tweens: Tween[] = [];
function tween(dur: number, update: (k: number) => void, done?: () => void): void {
  if (reducedMotion) { update(1); done?.(); return; }
  tweens.push({ t: 0, dur, update, ...(done ? { done } : {}) });
}

// -- camera ----------------------------------------------------------------------------------------
let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
let camPos = new Vector3(0, 8, 8);
let pulsing = false;
function cameraTarget(): Vector3 {
  const { cols, rows } = level!;
  const span = Math.max(cols, rows) * CELL;
  const aspect = view.w / Math.max(1, view.h);
  // Portrait: back off until the tray's full width (plus a margin) fits the
  // horizontal field of view, so narrow phones never crop the outer columns.
  const hHalf = Math.atan(Math.tan((camera.fov / 2) * PI / 180) * aspect);
  const fitWidth = ((span * 0.5 + 0.55) / Math.tan(hHalf) - 2.6) / 1.19;
  const dist = Math.max(span * (aspect < 1 ? 1.5 : 1.18), aspect < 1 ? fitWidth : 0);
  const tilt = cameraTilt === "top" ? 0.35 : 1.0;
  return new Vector3(0, dist * 0.95 * tilt + 2.2, dist * 0.72 + 1.4);
}
function frameCamera(snap: boolean): void {
  if (!level) return;
  camera.setViewOffset(view.w, view.h, -view.x, -view.y, view.W, view.H);
  const pos = cameraTarget();
  if (snap || reducedMotion) { camPos = pos; pulsing = false; }
  else {
    const from = camPos.clone();
    tween(0.6, (t) => { camPos = from.clone().lerp(pos, easeInOut(t)); });
  }
}
function cameraPulse(strength = 1): void {
  if (reducedMotion) return;
  const base = camPos.clone();
  pulsing = true;
  tween(0.5, (t) => {
    const k = Math.sin(t * PI * 2) * 0.04 * strength * (1 - t);
    camPos = new Vector3(base.x + k, base.y, base.z + k);
  }, () => { pulsing = false; frameCamera(false); });
}
/** The playfield (window pixels) the board is framed into, within the W × H window. */
export function setPlayfield(x: number, y: number, w: number, h: number, W: number, H: number): void {
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h), W: Math.max(1, W), H: Math.max(1, H) };
  if ((Object.keys(next) as (keyof typeof next)[]).every((k) => Math.abs(next[k] - view[k]) < 0.5)) return;
  view = next;
  if (!pulsing) frameCamera(true);
}
export function playfield(): { x: number; y: number; w: number; h: number } { return view; }
export function resetCamera(): void { frameCamera(false); }
/** Whether the cabinet draws (only in a round: the menus sit on the page colour). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

const ray = new Raycaster();
/** The cell under a window pixel, or -1 (src/render.js cellAt: the cells and the item bodies). */
export function pick(x: number, y: number): number {
  if (!level || !renderer.camera || x < view.x || y < view.y || x > view.x + view.w || y > view.y + view.h) return -1;
  ray.setFromCamera(pointerToNdc(x, y), camera);
  const bodies = [...meshById.values()].map((m) => m.group);
  const hits = ray.intersectObjects([...cellMeshes, ...bodies], true);
  for (const h of hits) {
    let o: Object3D | null = h.object;
    while (o) {
      const u = o.userData as { cell?: number };
      if (typeof u?.cell === "number") return u.cell;
      const it = [...meshById.values()].find((m) => m.group === o);
      if (it) return it.cell;
      o = o.parent;
    }
  }
  return -1;
}
/** A cell's square on screen (window pixels; for the accessibility targets and play scripts). */
export function cellScreen(cell: number): { x: number; y: number; size: number } | null {
  if (!level || !renderer.camera) return null;
  const p = cellToWorld(cell);
  const a = new Vector3(p.x, 0, p.z).project(camera);
  const b = new Vector3(p.x + CELL / 2, 0, p.z).project(camera);
  const sx = (a.x + 1) / 2 * view.W, sy = (1 - a.y) / 2 * view.H;
  const sx2 = (b.x + 1) / 2 * view.W;
  return { x: sx, y: sy, size: Math.abs(sx2 - sx) * 2 * 0.92 };
}

// -- the game's calls ------------------------------------------------------------------------------
/** A round's board: its theme (colours, fog, lights), the tray, the cabinet and the items. */
export function setLevel(l: LevelLike, s: BoardState): void {
  level = l;
  state = s;
  theme = THEMES.find((t) => t.id === l.theme) ?? THEMES[0]!;
  scene.background = new Color(theme.sky);
  scene.fog = new Fog(theme.fog, 14, 30);
  keyLight.color.set(theme.key);
  fillLight.color.set(theme.fill);
  tweens = [];
  rebuildAll();
  selectRing.visible = targetRing.visible = hintRing.visible = false;
  frameCamera(true);
}
export function setRestoration(fraction: number): void {
  restoration = Math.max(0, Math.min(1, fraction));
  applyRestoration();
}
/** The latest state and the events that led to it (src/render.js syncState): items reconcile, effects play. */
export function syncState(s: BoardState, events: RulesEvent[] = []): void {
  state = s;
  syncItems();
  if (reducedMotion) {
    if (events.some((e) => e.type === "win")) burst(new Vector3(0, 1, 0));
    return;
  }
  for (const e of events) {
    if (e.type === "spawn" && e.item && meshById.has(e.item.id)) {
      const g = meshById.get(e.item.id)!.group;
      g.scale.setScalar(0.01);
      tween(0.28, (t) => g.scale.setScalar(Math.max(0.01, easeOut(t))));
    } else if (e.type === "merge" && e.to !== undefined) {
      const p = cellToWorld(e.to);
      burst(new Vector3(p.x, 0.7, p.z));
      const m = e.item && meshById.get(e.item.id);
      if (m) tween(0.22, (t) => m.group.scale.setScalar(1 + Math.sin(t * PI) * 0.35));
    } else if (e.type === "deliver" && e.cell !== undefined) {
      const p = cellToWorld(e.cell);
      burst(new Vector3(p.x, 0.6, p.z), 0x9fe08a);
    } else if (e.type === "discover") burst(new Vector3(0, 1.4, 0), 0x8ecfff);
    else if (e.type === "win") { burst(new Vector3(0, 1, 0)); cameraPulse(); }
    else if (e.type === "lost") cameraPulse(0.4);
  }
}
/** A refused move shakes the cell's item (or the cell). */
export function shakeCell(cell: number): void {
  if (reducedMotion || !state || !level) return;
  const item = state.cells[cell];
  const target = (item && meshById.get(item.id)?.group) || cellMeshes[cell];
  if (!target) return;
  const base = target.position.clone();
  tween(0.3, (t) => {
    const k = Math.sin(t * PI * 6) * 0.08 * (1 - t);
    target.position.set(base.x + k, base.y, base.z);
  });
}
function placeRing(m: Mesh, cell: number): void {
  if (cell >= 0 && level) { const p = cellToWorld(cell); m.position.set(p.x, 0.02, p.z); m.visible = true; }
  else m.visible = false;
}
export function setSelected(cell: number): void { placeRing(selectRing, cell); }
export function setDragTarget(cell: number): void { placeRing(targetRing, cell); }
/** Merge hints carry from/to rather than a single cell: the ring marks the source. */
export function setHint(hint: { cell?: number; from?: number } | null): void { placeRing(hintRing, hint ? (hint.cell ?? hint.from ?? -1) : -1); }

/** Graphics level, high contrast (the label tiles) and the camera tilt option. */
export function setOptions(o: { highContrast: boolean; cameraTilt: string }): void {
  const hcChanged = o.highContrast !== highContrast;
  highContrast = o.highContrast;
  const tiltChanged = o.cameraTilt !== cameraTilt;
  cameraTilt = o.cameraTilt;
  if (hcChanged && level) { for (const id of [...meshById.keys()]) dropItem(id); syncItems(); }
  if (tiltChanged && level) frameCamera(false);
}
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const before = look;
  look = next;
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  // Image-based lighting from a neutral room so the pieces pick up soft reflections.
  scene.environment = next.reflections ? envMap() : null;
  fillLight.intensity = (next.reflections ? 0.9 : 1.25) / PI;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.35, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // A high threshold: only emissive gems, the lamp glass and bright highlights bloom (UnrealBloomPass 0.38, 0.45, 0.92).
  renderer.bloom = next.bloom ? { strength: 0.38, radius: 0.45, threshold: 0.92, resolution: next.budget.bloomRes } : null;
  // src/render.js GradeShader (display space): a gentle S-curve, a touch more
  // saturation, warm highlights / cool shadows and the 0.26 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.08, saturation: 1.07,
    shadows: [0.97, 0.98, 1.04], highlights: [1.04, 1.0, 0.95], split: [0.2, 0.8],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.85, scale: [1, 0.9] },
  } : null;
  renderer.antialias = next.antialias;
  if (!next.particlesHigh) motes.visible = false;
  // Asset variants (material class, rounded-box and prop segments, textures) are built into the meshes.
  const b = before?.budget;
  const assets = !b || before!.detailed !== next.detailed || b.material !== next.budget.material || b.pieceSegs !== next.budget.pieceSegs || b.propSegs !== next.budget.propSegs;
  if (assets && level) rebuildAll();
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on && tweens.length) { for (const t of tweens.splice(0)) { t.update(1); t.done?.(); } }
}
/** Leaves the round: nothing on the board. */
export function clear(): void {
  for (const id of [...meshById.keys()]) dropItem(id);
  clearGroup(boardGroup);
  if (diorama) { clearGroup(diorama); scene.remove(diorama); diorama = null; }
  cellMeshes = [];
  tweens = [];
  level = null;
  state = null;
  selectRing.visible = targetRing.visible = hintRing.visible = false;
  for (let i = 0; i < P_CAP; i++) { pLife[i] = 0; pPos[i * 3 + 1] = -100; }
  points.visible = false;
}

// -- the frame -------------------------------------------------------------------------------------
let time = 0;
/** One fixed step (ms): the tweens. */
export function tick(dtMs: number): void {
  const dt = dtMs / 1000;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]!;
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    tw.update(k);
    if (k >= 1) { tweens.splice(i, 1); tw.done?.(); }
  }
}
/** Each rendered frame: ambient motion (kit spin and bob, hint pulse, prop turn, lamp shimmer), motes, sparks, the camera. */
export function update(dtIn: number): void {
  const dt = Math.min(0.05, Math.max(0, dtIn));
  const still = reducedMotion;
  if (!still) time += dt;
  for (const m of meshById.values()) {
    if (still) { if (m.bob) m.bob.position.y = 0; continue; }
    if (m.spinRing) m.spinRing.rotation.z += dt * 0.8;
    if (m.bob) m.bob.position.y = Math.sin(time * 1.6 + m.phase) * 0.025 + 0.012;
    if (m.gem) m.gem.material.emissiveIntensity = 1.5 + Math.sin(time * 2.2 + m.phase) * 0.3;
  }
  if (!still) {
    if (hintRing.visible) hintRing.scale.setScalar(1 + Math.sin(time * 1000 / 220) * 0.12);
    for (const p of props) if (p.group.visible) p.art.rotation.y += dt * 0.4;
    if (lamp) {
      const f = 1 + Math.sin(time * 7.3) * 0.03 + Math.sin(time * 13.1) * 0.025;
      lamp.light.intensity = (5 / PI) * f;
      lamp.glass.material.emissiveIntensity = 3.2 * f;
      lamp.group.rotation.z = Math.sin(time * 0.6) * 0.02;
    }
  }
  // Dust motes drift up through the lamplight and wrap around.
  motes.visible = !!look && look.particlesHigh && !still && !!level;
  if (motes.visible) {
    const n = Math.min(MOTES, look!.budget.motes);
    moteGeo.setDrawRange(0, n);
    for (let i = 0; i < n; i++) {
      const sd = moteSeeds[i]!;
      let y = motePos[i * 3 + 1]! + dt * (0.06 + (sd % 1) * 0.05);
      if (y > 3.6) y = 0.3;
      motePos[i * 3] = motePos[i * 3]! + Math.sin(time * 0.4 + sd) * dt * 0.08;
      motePos[i * 3 + 1] = y;
      motePos[i * 3 + 2] = motePos[i * 3 + 2]! + Math.cos(time * 0.33 + sd) * dt * 0.08;
    }
    (moteGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
  }
  if (points.visible) {
    let alive = 0;
    for (let i = 0; i < P_CAP; i++) {
      if (pLife[i]! <= 0) continue;
      pLife[i] = pLife[i]! - dt;
      if (pLife[i]! <= 0) { pPos[i * 3 + 1] = -100; continue; }
      alive++;
      pVel[i * 3 + 1] = pVel[i * 3 + 1]! - 6 * dt;
      pPos[i * 3] = pPos[i * 3]! + pVel[i * 3]! * dt;
      pPos[i * 3 + 1] = Math.max(0, pPos[i * 3 + 1]! + pVel[i * 3 + 1]! * dt);
      pPos[i * 3 + 2] = pPos[i * 3 + 2]! + pVel[i * 3 + 2]! * dt;
    }
    (pGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
    if (!alive) points.visible = false;
  }
  camera.position.copy(camPos);
  camera.lookAt(0, 0, 0);
}
