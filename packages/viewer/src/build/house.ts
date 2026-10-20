import * as THREE from 'three/webgpu';
import type { Plan, Wall, Opening, Room, Vec2 } from '../plan/schema.ts';
import { withDefaults } from '../plan/schema.ts';
import {
  wallDir, wallLength, wallThickness, wallHeight, wallEndExtensions, roomAt, pointSegment, EPS,
  planBounds, polygonCentroid, roomNetArea,
} from '../plan/geom.ts';
import type { MaterialLibrary } from './materials.ts';
import { buildFurniture, type ModelInfo } from './furniture.ts';
import { buildDressing } from './dressing.ts';
import { buildOpenings } from './openings.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Plan cut height for the dollhouse cutaway and plan view, as on architectural drawings. */
export const CUT_HEIGHT = 1.2;
/** Cut-plane height that clips nothing. */
export const NO_CUT = 1e4;

export interface BuiltRoom {
  room: Room;
  center: THREE.Vector3;
  netArea: number;
}

/** A furniture piece or opening as a world box; merging bakes the pieces into shared meshes. */
export interface PickPart {
  kind: 'furniture' | 'opening';
  id: string;
  box: THREE.Box3;
}

export interface BuiltHouse {
  /**
   * Clips everything above `clipPlane`. Clipping stays enabled: toggling `enabled` recompiled
   * every material, so "no cut" moves the plane above the house instead.
   */
  root: THREE.ClippingGroup;
  walls: THREE.Group;
  /** Flat poché caps drawn at the cut height; visible only while the cut is on. */
  caps: THREE.Group;
  ceilings: THREE.Group;
  lights: THREE.Group;
  /** Soft spots in the window openings that stand in for skylight; shown in day light. */
  daylight: THREE.Group;
  furniture: THREE.Group;
  /** Invisible copies of everything the walker collides with. */
  colliders: THREE.Group;
  rooms: BuiltRoom[];
  /** What a ray hit: merged groups carry `userData.part`, single pieces are found by box. */
  parts: PickPart[];
  /** Horizontal cut plane, owned by the root ClippingGroup so every pass sees the same cut. */
  clipPlane: THREE.Plane;
  bounds: ReturnType<typeof planBounds>;
  dispose(): void;
}

/** Plan (x, y) to world (x, height, y). */
export const toWorld = (p: Vec2, h = 0) => new THREE.Vector3(p[0], h, p[1]);

/**
 * Local wall frame: +x along a→b, +y up, +z to the right of travel in plan
 * view. That keeps the basis right-handed so face winding survives the
 * transform. Left side = local −z.
 */
function wallMatrix(w: Wall) {
  const d = wallDir(w);
  const m = new THREE.Matrix4();
  m.makeBasis(new THREE.Vector3(d[0], 0, d[1]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-d[1], 0, d[0]));
  m.setPosition(w.a[0], 0, w.a[1]);
  return m;
}

/**
 * A box in wall-local space with UVs in meters, so textures keep their real
 * scale and line up across the pieces of one wall.
 */
function wallBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    if (nx > 0.5) uv.setXY(i, z, y);
    else if (ny > 0.5) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  return g;
}

interface Piece { x0: number; x1: number; y0: number; y1: number }

function wallPieces(plan: Plan, w: Wall, openings: Opening[]): Piece[] {
  const d = withDefaults(plan);
  const L = wallLength(w);
  const H = wallHeight(plan, w);
  const [e0, e1] = wallEndExtensions(plan, w);
  const holes = openings
    .map((o) => {
      const isWin = o.type === 'window';
      const sill = isWin ? (o.sill ?? d.windowSill) : 0;
      const h = o.height ?? (isWin ? d.windowHeight : o.type === 'garage-door' ? 2.2 : d.doorHeight);
      return { s: o.offset - o.width / 2, e: o.offset + o.width / 2, sill, top: Math.min(H, sill + h) };
    })
    .sort((a, b) => a.s - b.s);
  const pieces: Piece[] = [];
  let cursor = -e0;
  for (const h of holes) {
    if (h.s > cursor + 1e-4) pieces.push({ x0: cursor, x1: h.s, y0: 0, y1: H });
    if (h.sill > 1e-4) pieces.push({ x0: h.s, x1: h.e, y0: 0, y1: h.sill });
    if (h.top < H - 1e-4) pieces.push({ x0: h.s, x1: h.e, y0: h.top, y1: H });
    cursor = Math.max(cursor, h.e);
  }
  if (L + e1 > cursor + 1e-4) pieces.push({ x0: cursor, x1: L + e1, y0: 0, y1: H });
  return pieces;
}

/** Room on one side of a wall at distance u along it, if any. */
function roomBeside(plan: Plan, w: Wall, side: -1 | 1, u: number) {
  const dir = wallDir(w);
  const t = wallThickness(plan, w);
  return roomAt(plan, [
    w.a[0] + dir[0] * u - dir[1] * side * (t / 2 + 0.08),
    w.a[1] + dir[1] * u + dir[0] * side * (t / 2 + 0.08),
  ]);
}

/** Finish for one face of a wall piece: the room on that side, else exterior or default paint. */
function faceFinish(plan: Plan, w: Wall, side: -1 | 1, u: number) {
  const d = withDefaults(plan);
  const r = roomBeside(plan, w, side, u);
  if (r) return r.wallFinish ?? d.interiorFinish;
  return w.exterior ? d.exteriorFinish : d.interiorFinish;
}

/**
 * Where other walls meet this one partway along (T-junctions). Faces are split
 * there because the rooms on either side of a junction usually have different finishes.
 */
function junctions(plan: Plan, w: Wall) {
  const L = wallLength(w);
  const out: number[] = [];
  for (const o of plan.walls) {
    if (o === w) continue;
    for (const p of [o.a, o.b]) {
      const { d, t } = pointSegment(p, w.a, w.b);
      const u = t * L;
      if (d < EPS && u > 0.05 && u < L - 0.05) out.push(u);
    }
  }
  return out.sort((x, y) => x - y);
}

function buildWalls(plan: Plan, lib: MaterialLibrary, clipLib: (k: string) => THREE.Material) {
  const walls = new THREE.Group();
  walls.name = 'walls';
  const caps = new THREE.Group();
  caps.name = 'caps';
  const capMat = new THREE.MeshBasicMaterial({ color: '#2a2a28' });
  const topKey = 'wall-top';
  const top = clipLib(topKey);
  const skirting = clipLib('skirting');
  void lib;
  for (const w of plan.walls) {
    const t = wallThickness(plan, w);
    const m = wallMatrix(w);
    const openings = (plan.openings ?? []).filter((o) => o.wall === w.id);
    const L = wallLength(w);
    const cuts = junctions(plan, w);
    const pieces = wallPieces(plan, w, openings).flatMap((p) => {
      const inside = cuts.filter((u) => u > p.x0 + 1e-3 && u < p.x1 - 1e-3);
      const xs = [p.x0, ...inside, p.x1];
      return xs.slice(1).map((x1, i) => ({ ...p, x0: xs[i], x1 }));
    });
    for (const p of pieces) {
      // Sample the rooms at the piece's middle, clamped onto the wall itself.
      const u = Math.min(L, Math.max(0, (p.x0 + p.x1) / 2));
      // BoxGeometry face order: +x, −x, +y, −y, +z (right), −z (left).
      const mats = [top, top, top, top, clipLib(faceFinish(plan, w, 1, u)), clipLib(faceFinish(plan, w, -1, u))];
      const roomSides = ([1, -1] as const).filter((side) => roomBeside(plan, w, side, u));
      const mesh = new THREE.Mesh(wallBox(p.x0, p.x1, p.y0, p.y1, -t / 2, t / 2), mats);
      mesh.applyMatrix4(m);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.collide = true;
      mesh.userData.kind = 'wall';
      mesh.userData.id = w.id;
      walls.add(mesh);
      // Skirting boards on room-facing sides; door gaps have no floor-level piece, so they skip themselves.
      if (p.y0 === 0)
        for (const side of roomSides) {
          const sk = new THREE.Mesh(wallBox(p.x0, p.x1, 0, 0.07, 0, 0.012), skirting);
          sk.position.z = side === 1 ? t / 2 : -t / 2 - 0.012;
          sk.applyMatrix4(m);
          sk.receiveShadow = true;
          walls.add(sk);
        }
      if (p.y0 <= CUT_HEIGHT && p.y1 >= CUT_HEIGHT) {
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(p.x1 - p.x0, t), capMat);
        cap.rotation.x = -Math.PI / 2;
        cap.position.set((p.x0 + p.x1) / 2, CUT_HEIGHT - 0.002, 0);
        cap.applyMatrix4(m);
        caps.add(cap);
      }
    }
  }
  caps.visible = false;
  return { walls, caps };
}

function shapeFrom(poly: Vec2[], flipY: boolean) {
  const s = new THREE.Shape();
  poly.forEach((p, i) => {
    if (i) s.lineTo(p[0], flipY ? -p[1] : p[1]);
    else s.moveTo(p[0], flipY ? -p[1] : p[1]);
  });
  s.closePath();
  return s;
}

function buildFloorsAndCeilings(plan: Plan, lib: MaterialLibrary) {
  const d = withDefaults(plan);
  const floors = new THREE.Group();
  floors.name = 'floors';
  const ceilings = new THREE.Group();
  ceilings.name = 'ceilings';
  for (const r of plan.rooms ?? []) {
    // Floor: shape in (x, −y), rotated up so world z = plan y and the normal points up.
    const fg = new THREE.ShapeGeometry(shapeFrom(r.polygon, true));
    fg.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(fg, lib.get(r.floor ?? d.floor));
    floor.receiveShadow = true;
    floor.userData.collide = true;
    floor.userData.kind = 'floor';
    floor.userData.room = r.id;
    floors.add(floor);

    const cg = new THREE.ShapeGeometry(shapeFrom(r.polygon, false));
    cg.rotateX(Math.PI / 2); // normal faces down
    const ceil = new THREE.Mesh(cg, lib.get(r.ceiling ?? d.ceiling));
    // 1 cm below the wall tops, so the ceiling tucks into the walls and no seam can open.
    ceil.position.y = (r.ceilingHeight ?? d.wallHeight) - 0.01;
    ceil.receiveShadow = true;
    ceil.userData.kind = 'ceiling';
    ceilings.add(ceil);
  }
  return { floors, ceilings };
}

/** Rough blackbody approximation, good enough for warm or cool interior light. */
export function kelvinToColor(k: number) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

function buildLights(plan: Plan, lib: MaterialLibrary, shadows: boolean) {
  const d = withDefaults(plan);
  const lights = new THREE.Group();
  lights.name = 'room-lights';
  for (const r of plan.rooms ?? []) {
    if (!r.lightK) continue;
    const c = polygonCentroid(r.polygon);
    const h = (r.ceilingHeight ?? d.wallHeight) - 0.02;
    // Half-way to white: eyes white-balance indoors, so raw blackbody color reads far too orange.
    const color = kelvinToColor(r.lightK).lerp(new THREE.Color('#ffffff'), 0.5);
    const area = roomNetArea(plan, r.polygon);
    // Scaled against the 3.2 lux sun, not real candela: about 0.5 per m² of floor
    // lands an evening room a little dimmer than daylight.
    const light = new THREE.PointLight(color, Math.min(14, 0.5 * area), 0, 2);
    // Evening lamps cast real soft shadows: chair legs and the sofa throw pools of shade on
    // the floor. Static lights over a static house, so the cube maps render once and are cached.
    light.castShadow = shadows;
    light.shadow.mapSize.set(512, 512);
    // Wide filter: a real fixture is a 30 cm diffuser, so its shadows have broad penumbrae.
    light.shadow.radius = 7;
    light.shadow.bias = -0.0008;
    light.shadow.normalBias = 0.02;
    light.shadow.camera.near = 0.05;
    light.shadow.camera.far = 12;
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = true;
    light.position.set(c[0], h - 0.25, c[1]);
    light.userData.room = r.id;
    lights.add(light);
    const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 32), lib.get('bulb'));
    fixture.position.set(c[0], h - 0.015, c[1]);
    lights.add(fixture);
  }
  return lights;
}

/**
 * Skylight portals. Real interiors get most daylight as diffuse sky through the windows,
 * brightest on the floor just inside. A wide, soft spot inside each exterior window adds that
 * pool of light; every light costs shading time on every pixel, so only the six largest windows get one.
 */
function buildDaylight(plan: Plan) {
  const d = withDefaults(plan);
  const group = new THREE.Group();
  group.name = 'daylight';
  const candidates: { area: number; light: THREE.SpotLight }[] = [];
  for (const o of plan.openings ?? []) {
    if (o.type !== 'window' && o.type !== 'sliding-door' && o.type !== 'double-door') continue;
    const w = plan.walls.find((x) => x.id === o.wall);
    if (!w?.exterior) continue;
    const dir = wallDir(w);
    const t = wallThickness(plan, w);
    const sill = o.type === 'window' ? (o.sill ?? d.windowSill) : 0;
    const h = o.height ?? (o.type === 'window' ? d.windowHeight : 2.25);
    const mid: Vec2 = [w.a[0] + dir[0] * o.offset, w.a[1] + dir[1] * o.offset];
    // Find the inside of the wall at this opening.
    let inward: Vec2 | null = null;
    for (const s of [1, -1]) {
      const n: Vec2 = [-dir[1] * s, dir[0] * s];
      if (roomAt(plan, [mid[0] + n[0] * (t / 2 + 0.2), mid[1] + n[1] * (t / 2 + 0.2)])) inward = n;
    }
    if (!inward) continue;
    const area = o.width * h;
    // Aimed steeply at the floor in front of the window, like the pool of light a real
    // window throws. A wider cone grazed the far wall tops and drew a seam under the ceiling.
    // Kept low on purpose: real window fill is far weaker than a sun patch, and that
    // 10–30× gap is what reads as cinematic. Eye adaptation brings the room back up.
    const spot = new THREE.SpotLight('#e9f1ff', 7 * area, 0, 0.85, 1, 2);
    spot.position.set(mid[0] + inward[0] * (t / 2 + 0.15), sill + h * 0.6, mid[1] + inward[1] * (t / 2 + 0.15));
    spot.target.position.set(mid[0] + inward[0] * 1.3, 0, mid[1] + inward[1] * 1.3);
    spot.castShadow = false;
    candidates.push({ area, light: spot });
  }
  candidates.sort((a, b) => b.area - a.area);
  for (const c of candidates.slice(0, 6)) group.add(c.light, c.light.target);
  return group;
}

/**
 * Collapses every static mesh in a group into one mesh per material. The house has ~1,600
 * small meshes (wall pieces, trims, cushions, books); each is a draw call in every pass,
 * which cost more CPU per frame than 120 fps allows. Visibility per group still works.
 */
function mergeStatic(group: THREE.Object3D) {
  group.updateMatrixWorld(true);
  const toWorld = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<string, { mat: THREE.Material; cast: boolean; recv: boolean; geos: THREE.BufferGeometry[] }>();
  const doomed: THREE.Mesh[] = [];
  const m = new THREE.Matrix4();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || !mesh.visible) return;
    // Merge only what every pass can share: position, normal and one UV set.
    const src = mesh.geometry;
    if (!src.attributes.position || !src.attributes.normal) return;
    const g = src.index ? src.toNonIndexed() : src.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    m.multiplyMatrices(toWorld, mesh.matrixWorld);
    g.applyMatrix4(m);
    if (m.determinant() < 0) {
      // A mirrored piece (scale.x = −1) flips its triangles inside out once baked; swap back.
      for (const a of Object.values(g.attributes) as THREE.BufferAttribute[]) {
        const n = a.itemSize, arr = a.array as Float32Array;
        for (let t = 0; t < a.count; t += 3) for (let k = 0; k < n; k++) {
          const i1 = (t + 1) * n + k, i2 = (t + 2) * n + k;
          [arr[i1], arr[i2]] = [arr[i2], arr[i1]];
        }
      }
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = src.groups.length && Array.isArray(mesh.material) ? src.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
    for (const gr of groups) {
      const mat = mats[gr.materialIndex ?? 0];
      if (!mat) continue;
      const part = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(g.attributes) as [string, THREE.BufferAttribute][]) {
        const n = a.itemSize;
        part.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(gr.start * n, (gr.start + gr.count) * n), n));
      }
      const key = `${mat.uuid}|${mesh.castShadow}|${mesh.receiveShadow}`;
      let b = buckets.get(key);
      if (!b) {
        b = { mat, cast: mesh.castShadow, recv: mesh.receiveShadow, geos: [] };
        buckets.set(key, b);
      }
      b.geos.push(part);
    }
    g.dispose();
    doomed.push(mesh);
  });
  for (const mesh of doomed) mesh.removeFromParent();
  // Empty helper groups left behind are harmless; drop them to keep traversal short.
  for (const { mat, cast, recv, geos } of buckets.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const out = new THREE.Mesh(merged, mat);
    out.castShadow = cast;
    out.receiveShadow = recv;
    group.add(out);
  }
}

export async function buildHouse(
  plan: Plan,
  lib: MaterialLibrary,
  opts: {
    resolveUrl: (p: string) => string | undefined;
    modelInfo?: (path: string) => ModelInfo;
    manager?: THREE.LoadingManager;
    /** Cube shadows for the evening room lights; off on phones. */
    lampShadows?: boolean;
  },
): Promise<BuiltHouse> {
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_HEIGHT);
  const root = new THREE.ClippingGroup();
  root.name = 'house';
  root.clippingPlanes = [clipPlane];
  root.clipShadows = true;
  const clipCache = new Map<string, THREE.Material>();
  // Separate copies for architecture so tweaking a wall finish never repaints furniture.
  const clipLib = (key: string) => {
    // Bulbs and lenses share the library material so one emissive intensity dims them all with the lamps.
    if (key === 'bulb') return lib.get(key);
    let m = clipCache.get(key);
    if (!m) {
      const base = key === 'wall-top' ? lib.get('paint-white') : lib.get(key);
      m = base.clone();
      if (key === 'wall-top') (m as THREE.MeshStandardMaterial).color.set('#d9d4ca');
      clipCache.set(key, m);
    }
    return m;
  };

  const { walls, caps } = buildWalls(plan, lib, clipLib);
  const { floors, ceilings } = buildFloorsAndCeilings(plan, lib);
  const openings = buildOpenings(plan, clipLib);
  const furniture = await buildFurniture(plan, lib, clipLib, opts.resolveUrl, opts.modelInfo, opts.manager);
  const lights = buildLights(plan, lib, opts.lampShadows ?? true);
  const daylight = buildDaylight(plan);
  const dressing = buildDressing(plan, lib, clipLib);
  root.add(floors, walls, caps, openings, ceilings, furniture, dressing, lights, daylight);

  // Slab and plinth so the house does not float on the ground plane.
  const b = planBounds(plan);
  const d = withDefaults(plan);
  const pad = d.exteriorThickness / 2 + 0.05;
  // A solid roof slab above the ceilings. It travels with the ceilings (walk mode only) and
  // gives the sun's shadow a solid caster; a zero-thickness ceiling leaks sunlight along wall tops.
  const roofMat = lib.get('slab').clone();
  // Shadow maps store back faces by default, i.e. the roof's underside 1 cm above the wall
  // tops; with shadow bias that left the top of every wall sunlit. Store the top face instead.
  roofMat.shadowSide = THREE.FrontSide;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(b.w + pad * 2, 0.3, b.h + pad * 2), roofMat);
  // Bottom sits 5 mm into the wall tops so there is no slot between walls and roof.
  roof.position.set(b.cx, d.wallHeight + 0.145, b.cy);
  roof.castShadow = true;
  ceilings.add(roof);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(b.w + pad * 2, 0.3, b.h + pad * 2), lib.get('slab'));
  slab.position.set(b.cx, -0.151, b.cy);
  slab.receiveShadow = true;
  slab.userData.collide = true;
  root.add(slab);

  root.updateMatrixWorld(true);
  const colliders = new THREE.Group();
  // Furniture collides as one box per piece; per-triangle collision on cushions only slows the walker.
  for (const f of furniture.children) {
    if (!f.userData.collide) continue;
    const rot = f.rotation.y;
    f.rotation.y = 0;
    f.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(f);
    f.rotation.y = rot;
    f.updateMatrixWorld(true);
    const size = bb.getSize(new THREE.Vector3());
    const c = bb.getCenter(new THREE.Vector3()).sub(f.position);
    const geo = new THREE.BoxGeometry(size.x, size.y, size.z).translate(c.x, c.y, c.z);
    const col = new THREE.Mesh(geo);
    col.matrixAutoUpdate = false;
    col.matrix.copy(f.matrixWorld);
    col.matrixWorld.copy(f.matrixWorld);
    colliders.add(col);
  }
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.collide) {
      const c = new THREE.Mesh((o as THREE.Mesh).geometry);
      c.matrixAutoUpdate = false;
      c.matrix.copy(o.matrixWorld);
      c.matrixWorld.copy(o.matrixWorld);
      colliders.add(c);
    }
  });

  const parts: PickPart[] = [];
  for (const [group, kind] of [[furniture, 'furniture'], [openings, 'opening']] as const) {
    group.userData.part = kind;
    for (const o of group.children) {
      if (o.userData.kind === kind) parts.push({ kind, id: o.userData.id, box: new THREE.Box3().setFromObject(o).expandByScalar(0.03) });
    }
  }
  floors.userData.part = 'floor';
  walls.userData.part = caps.userData.part = 'wall';

  for (const g of [floors, walls, caps, openings, ceilings, furniture, dressing]) mergeStatic(g);

  const rooms: BuiltRoom[] = (plan.rooms ?? []).map((r) => {
    const c = polygonCentroid(r.polygon);
    return { room: r, center: new THREE.Vector3(c[0], 0, c[1]), netArea: roomNetArea(plan, r.polygon) };
  });

  return {
    root, walls, caps, ceilings, lights, daylight, furniture, colliders, rooms, parts, clipPlane, bounds: b,
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of clipCache.values()) m.dispose();
    },
  };
}
