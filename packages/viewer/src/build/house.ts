import * as THREE from 'three/webgpu';
import type { Furniture, Level, Plan, Wall, Opening, Room, Vec2 } from '../plan/schema.ts';
import { withDefaults } from '../plan/schema.ts';
import {
  wallDir, wallLength, wallThickness, wallHeight, wallEndExtensions, roomAt, pointSegment, EPS,
  planBounds, polygonCentroid, roomNetArea, pointInPolygon, ceilingAt,
} from '../plan/geom.ts';
import { levelOf, levelPlan, levels, stairFlights, type StairFlight } from '../plan/levels.ts';
import { defaultDesignOption, shownInOption } from '../plan/options.ts';
import { surfaceFinish, surfaceId, wallFaceFinish } from '../plan/surfaces.ts';
import type { DesignOption } from '../plan/schema.ts';
import type { MaterialLibrary } from './materials.ts';
import { buildFurniture, type ModelInfo } from './furniture.ts';
import { buildDressing } from './dressing.ts';
import { buildOpenings } from './openings.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Plan cut height for the dollhouse cutaway and plan view, as on architectural drawings. */
export const CUT_HEIGHT = 1.2;
/** Cut-plane height that clips nothing. */
export const NO_CUT = 1e4;
/** Thickness of the floor slab under an upper storey. */
export const SLAB = 0.2;

export interface BuiltRoom {
  room: Room;
  level: Level;
  /** Centroid at the room's floor height. */
  center: THREE.Vector3;
  netArea: number;
}

/** One storey: its cut heights above the ground floor, and the wall caps drawn at each. */
export interface BuiltLevel {
  level: Level;
  /** Plan cut, 1.2 m above this floor. */
  cut: number;
  /** Just under the slab of the storey above; `NO_CUT` on the top storey. */
  top: number;
  cutCaps: THREE.Group;
  /** Wall caps at `top`; empty on the top storey. */
  topCaps: THREE.Group;
}

/** A furniture piece or opening as a world box; merging bakes the pieces into shared meshes. */
export interface PickPart {
  kind: 'furniture' | 'opening';
  id: string;
  box: THREE.Box3;
  /** Hidden with the loose furniture. */
  loose?: boolean;
  /** Shown only in these design options. */
  designOptions?: string[];
}

export interface BuiltHouse {
  /**
   * Clips everything above `clipPlane`. Clipping stays enabled: toggling `enabled` recompiled
   * every material, so "no cut" moves the plane above the house instead.
   */
  root: THREE.ClippingGroup;
  walls: THREE.Group;
  floors: THREE.Group;
  /** Flat poché caps drawn at the cut heights of each storey; one set shows while a cut is on. */
  caps: THREE.Group;
  ceilings: THREE.Group;
  lights: THREE.Group;
  /** Soft spots in the window openings that stand in for skylight; shown in day light. */
  daylight: THREE.Group;
  furniture: THREE.Group;
  /** Loose furniture and its decor, the part "hide furniture" turns off; fixtures stay. */
  looseFurniture: THREE.Group;
  /** Invisible copies of everything the walker collides with. */
  colliders: THREE.Group;
  /** `colliders` without the loose furniture. */
  collidersFixed: THREE.Group;
  /** Roofs the plan supplies (`roof: true`); empty when the viewer adds its own slab. */
  roofs: THREE.Group;
  /** The design option on show; null for a plan without options. */
  readonly designOption: string | null;
  /** Shows another design option: its finishes and furniture replace the current ones in place. */
  setDesignOption(option: DesignOption | null): void;
  rooms: BuiltRoom[];
  /** Storeys bottom to top. A plan without `levels` has one. */
  levels: BuiltLevel[];
  /** Changes the house in place for hand editing; only a house built `editable` has one. */
  editor: HouseEditor | null;
  /** What a ray hit: merged groups carry `userData.part`, single pieces are found by box. */
  parts: PickPart[];
  /** Horizontal cut plane, owned by the root ClippingGroup so every pass sees the same cut. */
  clipPlane: THREE.Plane;
  bounds: ReturnType<typeof planBounds>;
  dispose(): void;
}

/**
 * An editable house keeps every piece, wall and floor as its own mesh, so pieces can move and
 * surfaces take new finishes without a rebuild. It draws far more calls than a merged house.
 */
export interface HouseEditor {
  /** Each piece's object by plan id; its `userData.piece` is the plan entry it was built from. */
  pieces: Map<string, THREE.Object3D>;
  /** Builds a piece, or builds it again after its look changed, and puts it in the scene. */
  build(piece: Furniture): Promise<THREE.Object3D>;
  remove(id: string): void;
  /** Gives every wall face and floor the finish `plan` names for it now. */
  repaint(plan: Plan): void;
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
  return wallFaceFinish(plan, w, roomBeside(plan, w, side, u) ?? null);
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

/** An extended end covered by another solid wall has no exposed end face. */
function coveredWallEnd(plan: Plan, wall: Wall, end: 0 | 1, extension: number, extensions: Map<Wall, [number, number]>) {
  if (!extension) return false;
  const direction = wallDir(wall), point = end ? wall.b : wall.a;
  const thickness = wallThickness(plan, wall), sign = end ? 1 : -1;
  const corners = [-1, 1].map(side => [
    point[0] + sign * direction[0] * extension - side * direction[1] * thickness / 2,
    point[1] + sign * direction[1] * extension + side * direction[0] * thickness / 2,
  ] as Vec2);
  return plan.walls.some(other => {
    if (other === wall || wallHeight(plan, other) < wallHeight(plan, wall) - EPS) return false;
    const along = wallDir(other), length = wallLength(other), half = wallThickness(plan, other) / 2;
    const [start, finish] = extensions.get(other)!;
    const projected = corners.map(corner => {
      const x = corner[0] - other.a[0], z = corner[1] - other.a[1];
      return { u: x * along[0] + z * along[1], v: -x * along[1] + z * along[0] };
    });
    if (projected.some(p => p.u < -start - EPS || p.u > length + finish + EPS || Math.abs(p.v) > half + EPS)) return false;
    const low = Math.min(...projected.map(p => p.u)), high = Math.max(...projected.map(p => p.u));
    return !(plan.openings ?? []).some(opening => opening.wall === other.id && high > opening.offset - opening.width / 2 + EPS && low < opening.offset + opening.width / 2 - EPS);
  });
}

function buildWalls(plan: Plan, lib: MaterialLibrary, clipLib: (k: string) => THREE.Material, capHeights: number[]) {
  const walls = new THREE.Group();
  walls.name = 'walls';
  const caps = capHeights.map(() => new THREE.Group());
  const capMat = new THREE.MeshBasicMaterial({ color: '#2a2a28' });
  const topKey = 'wall-top';
  const top = clipLib(topKey);
  const skirting = clipLib('skirting');
  const extensions = new Map(plan.walls.map(wall => [wall, wallEndExtensions(plan, wall)]));
  void lib;
  for (const w of plan.walls) {
    const t = wallThickness(plan, w);
    const m = wallMatrix(w);
    const openings = (plan.openings ?? []).filter((o) => o.wall === w.id);
    const L = wallLength(w);
    const [e0, e1] = extensions.get(w)!;
    const coveredStart = coveredWallEnd(plan, w, 0, e0, extensions), coveredEnd = coveredWallEnd(plan, w, 1, e1, extensions);
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
      // The paintable face on each side, by material slot, for hand editing.
      const face = (side: -1 | 1) => {
        const room = roomBeside(plan, w, side, u);
        return room ? surfaceId({ kind: 'wall', room: room.id, wall: w.id }) : surfaceId({ kind: 'outside', wall: w.id });
      };
      const geometry = wallBox(p.x0, p.x1, p.y0, p.y1, -t / 2, t / 2);
      // Keep the collider's closed volume, but omit render faces coplanar with the
      // neighbouring wall. Depth offsets merely hide the overlap from some angles.
      geometry.groups = geometry.groups.filter(face => !(
        (face.materialIndex === 1 && coveredStart && Math.abs(p.x0 + e0) < EPS) ||
        (face.materialIndex === 0 && coveredEnd && Math.abs(p.x1 - L - e1) < EPS)
      ));
      const mesh = new THREE.Mesh(geometry, mats);
      mesh.applyMatrix4(m);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.collide = true;
      mesh.userData.kind = 'wall';
      mesh.userData.id = w.id;
      mesh.userData.surfaces = [null, null, null, null, face(1), face(-1)];
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
      capHeights.forEach((h, i) => {
        if (p.y0 > h || p.y1 < h) return;
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(p.x1 - p.x0, t), capMat);
        cap.rotation.x = -Math.PI / 2;
        cap.position.set((p.x0 + p.x1) / 2, h - 0.002, 0);
        cap.applyMatrix4(m);
        caps[i].add(cap);
      });
    }
  }
  return { walls, caps };
}

function shapeFrom(poly: Vec2[], flipY: boolean, holes: Vec2[][] = []) {
  const s = new THREE.Shape();
  poly.forEach((p, i) => {
    if (i) s.lineTo(p[0], flipY ? -p[1] : p[1]);
    else s.moveTo(p[0], flipY ? -p[1] : p[1]);
  });
  s.closePath();
  for (const hole of holes) s.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, flipY ? -y : y))));
  return s;
}

/**
 * Floors and ceilings of one storey at `elevation`. Stairs cut their footprint out of the ceilings
 * they climb through and the floor they arrive at, when it lies wholly inside that room. Upper
 * storeys stand on a slab, which also closes the gap around a stairwell.
 */
function buildFloorsAndCeilings(plan: Plan, lib: MaterialLibrary, elevation: number, flights: StairFlight[], slab: boolean) {
  const d = withDefaults(plan);
  const floors = new THREE.Group();
  floors.name = 'floors';
  const ceilings = new THREE.Group();
  ceilings.name = 'ceilings';
  for (const r of plan.rooms ?? []) {
    const inside = (f: StairFlight) => f.footprint.every((p) => pointInPolygon(p, r.polygon));
    // Ceiling height over the middle of a flight, which matters under a sloped ceiling.
    const ceilingOver = (f: StairFlight) => ceilingAt(plan, r, polygonCentroid(f.footprint));
    const arrivals = flights.filter((f) => f.base < elevation - 0.05 && f.top >= elevation - 0.05 && inside(f));
    const arriving = arrivals.map((f) => f.footprint);
    for (const f of arrivals) floors.add(stairGuard(f.footprint, lib, plan));
    // Any flight starting on this storey, including the upper run from a half landing.
    const leaving = flights.filter((f) => f.base >= elevation - 0.05 && f.base < elevation + ceilingOver(f) && f.top > elevation + ceilingOver(f) - 0.05 && inside(f)).map((f) => f.footprint);
    // Floor: shape in (x, −y), rotated up so world z = plan y and the normal points up.
    const fg = new THREE.ShapeGeometry(shapeFrom(r.polygon, true, arriving));
    fg.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(fg, lib.get(r.floor ?? d.floor));
    floor.receiveShadow = true;
    floor.userData.collide = true;
    floor.userData.kind = 'floor';
    floor.userData.room = r.id;
    floor.userData.surface = surfaceId({ kind: 'floor', room: r.id });
    floors.add(floor);
    if (slab) {
      const sg = new THREE.ExtrudeGeometry(shapeFrom(r.polygon, true, arriving), { depth: SLAB, bevelEnabled: false });
      sg.rotateX(-Math.PI / 2);
      sg.translate(0, -SLAB - 0.002, 0);
      const under = new THREE.Mesh(sg, lib.get(r.ceiling ?? d.ceiling));
      under.receiveShadow = under.castShadow = true;
      floors.add(under);
    }

    const cg = new THREE.ShapeGeometry(shapeFrom(r.polygon, false, leaving));
    cg.rotateX(Math.PI / 2); // normal faces down
    // 1 cm below the wall tops, so the ceiling tucks into the walls and no seam can open. A sloped
    // ceiling is a plane, so lifting each corner to its height keeps every triangle on it.
    const position = cg.attributes.position;
    for (let i = 0; i < position.count; i++) position.setY(i, ceilingAt(plan, r, [position.getX(i), position.getZ(i)]) - 0.01);
    if (r.ceilingSlope) cg.computeVertexNormals();
    const ceil = new THREE.Mesh(cg, lib.get(r.ceiling ?? d.ceiling));
    ceil.receiveShadow = true;
    // Downward winding blocks the head without becoming upward-facing step support.
    ceil.userData.collide = true;
    ceil.userData.kind = 'ceiling';
    ceilings.add(ceil);
  }
  return { floors, ceilings };
}

/**
 * Lamps that cast shadows. Each shadow takes a texture slot in the evening shaders, which WebGPU caps
 * at 16 alongside the materials' own maps; past that nothing draws at night. The largest rooms keep theirs.
 */
export const MAX_LAMP_SHADOWS = 6;

/** Balustrade height around a stair opening, and its handrail. */
const GUARD = 0.9;

/**
 * Guards a stair opening on the floor it reaches: both sides and the far end, leaving open the
 * edge the top tread steps out over. Footprint corners run from that top edge, as `stairFlights` lists them.
 */
export function stairGuard(footprint: Vec2[], lib: MaterialLibrary, plan: Plan) {
  const group = new THREE.Group();
  // A side along a wall needs no guard: the wall is one, and a guard would sit inside it.
  const alongWall = (a: Vec2, b: Vec2) => plan.walls.some((w) => {
    const reach = wallThickness(plan, w) / 2 + 0.06;
    return [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2].every((p) => pointSegment(p, w.a, w.b).d <= reach);
  });
  for (const [a, b] of [[1, 2], [2, 3], [3, 0]].map(([i, j]) => [footprint[i], footprint[j]])) {
    if (alongWall(a, b)) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const turn = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    const at = (part: THREE.Mesh, y: number) => {
      part.position.set((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2);
      part.rotation.y = turn;
      part.castShadow = part.receiveShadow = true;
      return part;
    };
    const panel = at(new THREE.Mesh(new THREE.BoxGeometry(length, GUARD - 0.04, 0.04), lib.get('paint-white')), (GUARD - 0.04) / 2);
    panel.userData.collide = true;
    group.add(panel, at(new THREE.Mesh(new THREE.BoxGeometry(length + 0.04, 0.04, 0.06), lib.get('black-steel')), GUARD - 0.02));
  }
  return group;
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
  const lights = new THREE.Group();
  lights.name = 'room-lights';
  for (const r of plan.rooms ?? []) {
    if (!r.lightK) continue;
    const c = polygonCentroid(r.polygon);
    const h = ceilingAt(plan, r, c) - 0.02;
    // Half-way to white: eyes white-balance indoors, so raw blackbody color reads far too orange.
    const color = kelvinToColor(r.lightK).lerp(new THREE.Color('#ffffff'), 0.5);
    const area = roomNetArea(plan, r.polygon);
    // Scaled against the 3.2 lux sun, not real candela: about 0.5 per m² of floor
    // lands an evening room a little dimmer than daylight.
    const light = new THREE.PointLight(color, Math.min(14, 0.5 * area), 0, 2);
    // Evening lamps cast real soft shadows: chair legs and the sofa throw pools of shade on
    // the floor. Static lights over a static house, so the cube maps render once and are cached.
    light.castShadow = shadows;
    light.userData.area = area;
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
  // Door leaves and sliding panels move at runtime, so they keep their own meshes.
  // Design option groups merge on their own, so each can be shown or hidden.
  const live = (o: THREE.Object3D | null) => {
    for (; o && o !== group; o = o.parent) if (o.userData.dynamic || o.userData.optionGroup) return true;
    return false;
  };
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || live(mesh) || (mesh as THREE.InstancedMesh).isInstancedMesh || !mesh.visible) return;
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

/** Tread blocks of a `stairs` piece in its own frame, matching the treads the furniture builder draws. */
export function stairSteps([w, d, h]: [number, number, number]) {
  const n = Math.max(3, Math.round(h / 0.18));
  const rise = h / n, run = d / n;
  // The flight climbs from its front at +z toward −z.
  return Array.from({ length: n }, (_, i) => new THREE.BoxGeometry(w, rise * (i + 1), run).translate(0, (rise * (i + 1)) / 2, d / 2 - run * (i + 0.5)));
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
    /** Keeps pieces and surfaces apart for hand editing; see `HouseEditor`. */
    editable?: boolean;
  },
): Promise<BuiltHouse> {
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_HEIGHT);
  const root = new THREE.ClippingGroup();
  root.name = 'house';
  root.clippingPlanes = [clipPlane];
  root.clipShadows = true;
  // The plan opens on its default design option; the library makes that option's finishes.
  lib.applyDesignOption(defaultDesignOption(plan) ?? null);
  let designOption = defaultDesignOption(plan)?.id ?? null;
  const clipCache = new Map<string, THREE.Material>();
  const clipVariant = (key: string) => (key === 'wall-top' ? key : lib.variant(key));
  // Separate copies for architecture so tweaking a wall finish never repaints furniture.
  const clipLib = (key: string) => {
    // Bulbs and lenses share the library material so one emissive intensity dims them all with the lamps.
    if (key === 'bulb') return lib.get(key);
    let m = clipCache.get(clipVariant(key));
    if (!m) {
      const base = key === 'wall-top' ? lib.get('paint-white') : lib.get(key);
      m = base.clone();
      if (key === 'wall-top') {
        (m as THREE.MeshStandardMaterial).color.set('#d9d4ca');
        m.name = key;
      }
      clipCache.set(clipVariant(key), m);
    }
    return m;
  };

  const group = (name: string) => Object.assign(new THREE.Group(), { name });
  const walls = group('walls'), caps = group('caps'), floors = group('floors'), ceilings = group('ceilings');
  const openings = group('openings'), furniture = group('furniture'), lights = group('room-lights');
  const daylight = group('daylight'), dressing = group('dressing');
  caps.visible = false;
  // Each storey is built as a plan of its own, then lifted to its floor. Moving the children
  // themselves, not a wrapper, keeps light, opening and furniture lists flat for the viewer.
  const lift = (from: THREE.Object3D, to: THREE.Object3D, y: number) => {
    for (const o of [...from.children]) {
      o.position.y += y;
      to.add(o);
    }
  };
  const storeys = levels(plan);
  const flights = stairFlights(plan);
  const builtLevels: BuiltLevel[] = [];
  const storeyRooms: { room: Room; level: Level }[] = [];
  for (const [i, level] of storeys.entries()) {
    const storey = levelPlan(plan, level);
    const e = level.elevation;
    const above = storeys[i + 1];
    const top = above ? above.elevation - SLAB - 0.01 : NO_CUT;
    const built = buildWalls(storey, lib, clipLib, above ? [CUT_HEIGHT, top - e] : [CUT_HEIGHT]);
    lift(built.walls, walls, e);
    const [cutCaps, topCaps = new THREE.Group()] = built.caps.map((g) => {
      g.position.y = e;
      caps.add(g);
      return g;
    });
    builtLevels.push({ level, cut: e + CUT_HEIGHT, top, cutCaps, topCaps });
    const surfaces = buildFloorsAndCeilings(storey, lib, e, flights, i > 0);
    lift(surfaces.floors, floors, e);
    lift(surfaces.ceilings, ceilings, e);
    lift(buildOpenings(storey, clipLib), openings, e);
    lift(await buildFurniture(storey, lib, clipLib, opts.resolveUrl, opts.modelInfo, opts.manager), furniture, e);
    lift(buildLights(storey, lib, opts.lampShadows ?? true), lights, e);
    lift(buildDaylight(storey), daylight, e);
    lift(buildDressing(storey, lib, clipLib), dressing, e);
    for (const room of storey.rooms ?? []) storeyRooms.push({ room, level });
  }
  // Only the largest rooms' lamps cast shadows; see MAX_LAMP_SHADOWS.
  const shadowLamps = lights.children
    .filter((o): o is THREE.PointLight => (o as THREE.PointLight).isPointLight && o.castShadow)
    .sort((x, y) => (y.userData.area as number) - (x.userData.area as number));
  for (const lamp of shadowLamps.slice(MAX_LAMP_SHADOWS)) lamp.castShadow = false;
  // Fixtures and loose pieces merge separately so the loose group can hide without a re-merge.
  const pieces = [...furniture.children];
  const fixtures = new THREE.Group();
  const loose = new THREE.Group();
  const roofs = group('roofs');
  fixtures.name = 'fixtures';
  loose.name = 'loose';
  // Pieces and decor of a design option go in a group per set of options, shown with any of them.
  const optionGroups = new Map<string, THREE.Group>();
  const inOptions = (o: THREE.Object3D, parent: THREE.Group) => {
    const ids = o.userData.designOptions as string[] | undefined;
    if (!ids) return parent;
    const key = `${parent.name}:${ids.join('|')}`;
    let g = optionGroups.get(key);
    if (!g) {
      g = Object.assign(new THREE.Group(), { name: key });
      g.userData.designOptions = ids;
      g.userData.optionGroup = true;
      parent.add(g);
      optionGroups.set(key, g);
    }
    return g;
  };
  for (const o of pieces) (o.userData.roof ? roofs : inOptions(o, o.userData.loose ? loose : fixtures)).add(o);
  for (const o of [...dressing.children]) {
    if (o.userData.loose) inOptions(o, loose).add(o);
    else if (o.userData.ceiling) ceilings.add(o);
  }
  furniture.add(fixtures, loose);
  root.add(floors, walls, caps, openings, ceilings, furniture, roofs, dressing, lights, daylight);

  // Slab and plinth so the house does not float on the ground plane.
  const b = planBounds(plan);
  const d = withDefaults(plan);
  const pad = d.exteriorThickness / 2 + 0.05;
  const roofLevel = storeys[storeys.length - 1];
  const roofPlan = levelPlan(plan, roofLevel);
  const rb = planBounds(roofPlan);
  // A solid roof slab above the ceilings. It travels with the ceilings (walk mode only) and
  // gives the sun's shadow a solid caster; a zero-thickness ceiling leaks sunlight along wall tops.
  const roofMat = lib.get('slab').clone();
  // Shadow maps store back faces by default, i.e. the roof's underside 1 cm above the wall
  // tops; with shadow bias that left the top of every wall sunlit. Store the top face instead.
  roofMat.shadowSide = THREE.FrontSide;
  // A plan with its own roofs gets no generated slab: it would stand above a pitched roof's low eave.
  if (!roofs.children.length) {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(rb.w + pad * 2, 0.3, rb.h + pad * 2), roofMat);
    // Bottom sits 5 mm into the wall tops so there is no slot between walls and roof.
    roof.position.set(rb.cx, roofLevel.elevation + withDefaults(roofPlan).wallHeight + 0.145, rb.cy);
    roof.castShadow = true;
    roof.userData.collide = true;
    ceilings.add(roof);
  }
  const slab = new THREE.Mesh(new THREE.BoxGeometry(b.w + pad * 2, 0.3, b.h + pad * 2), lib.get('slab'));
  slab.position.set(b.cx, -0.151, b.cy);
  slab.receiveShadow = true;
  slab.userData.collide = true;
  root.add(slab);

  root.updateMatrixWorld(true);
  // Every collider, tagged with the design options of its piece; each option's world is cut from it.
  const colliders = new THREE.Group();
  // Furniture collides as one box per piece; per-triangle collision on cushions only slows the walker.
  const collidersFixed = new THREE.Group();
  for (const f of pieces) {
    if (!f.userData.collide) continue;
    if (f.userData.type === 'stairs') {
      // One solid block per tread, so the walker climbs them like any other step.
      for (const step of stairSteps(f.userData.size)) {
        const col = new THREE.Mesh(step);
        col.matrixAutoUpdate = false;
        col.matrix.copy(f.matrixWorld);
        col.matrixWorld.copy(f.matrixWorld);
        if (f.userData.designOptions) col.userData.designOptions = f.userData.designOptions;
        colliders.add(col);
        collidersFixed.add(col.clone());
      }
      continue;
    }
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
    col.userData.loose = !!f.userData.loose;
    if (f.userData.designOptions) col.userData.designOptions = f.userData.designOptions;
    colliders.add(col);
    if (!f.userData.loose) collidersFixed.add(col.clone());
  }
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.collide) {
      const c = new THREE.Mesh((o as THREE.Mesh).geometry);
      c.matrixAutoUpdate = false;
      c.matrix.copy(o.matrixWorld);
      c.matrixWorld.copy(o.matrixWorld);
      colliders.add(c);
      collidersFixed.add(c.clone());
    }
  });

  const parts: PickPart[] = [];
  for (const [group, kind, list] of [[furniture, 'furniture', pieces], [openings, 'opening', openings.children]] as const) {
    group.userData.part = kind;
    for (const o of list) {
      if (o.userData.kind === kind) {
        parts.push({
          kind, id: o.userData.id, box: new THREE.Box3().setFromObject(o).expandByScalar(0.03),
          ...(o.userData.loose && { loose: true }), ...(o.userData.designOptions && { designOptions: o.userData.designOptions }),
        });
      }
    }
  }
  floors.userData.part = 'floor';
  // A picked roof reports the plan piece it is, like any other furniture.
  roofs.userData.part = 'furniture';
  walls.userData.part = caps.userData.part = 'wall';

  const editable = opts.editable ?? false;
  for (const g of [...caps.children, openings, ceilings, dressing]) mergeStatic(g);
  if (!editable) for (const g of [floors, walls, ...optionGroups.values(), fixtures, loose, roofs]) mergeStatic(g);
  for (const o of pieces) o.userData.piece = plan.furniture?.find((f) => f.id === o.userData.id);

  // The walker's world for one option: shared colliders plus that option's pieces.
  const worlds = new Map<string, THREE.Group>();
  const world = (all: THREE.Group, option: string | null) => {
    const key = `${all === colliders ? 'all' : 'fixed'}|${option}`;
    let w = worlds.get(key);
    if (!w) {
      w = new THREE.Group();
      for (const c of all.children) if (shownInOption(c.userData, option)) w.add(c.clone());
      worlds.set(key, w);
    }
    return w;
  };
  const showOption = () => {
    for (const g of optionGroups.values()) g.visible = shownInOption(g.userData, designOption);
  };
  showOption();
  /** Points every mesh using one material at another; materials are matched by identity, never by name. */
  const swap = (from: THREE.Material, to: THREE.Material) => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((m) => (m === from ? to : m));
      else if (mesh.material === from) mesh.material = to;
    });
  };

  const rooms: BuiltRoom[] = storeyRooms.map(({ room, level }) => {
    const c = polygonCentroid(room.polygon);
    return { room, level, center: new THREE.Vector3(c[0], level.elevation, c[1]), netArea: roomNetArea(levelPlan(plan, level), room.polygon) };
  });

  const pieceMap = new Map(pieces.map((o) => [o.userData.id as string, o]));
  const editor: HouseEditor | null = editable ? {
    pieces: pieceMap,
    async build(piece) {
      const level = levelOf(plan, piece.level);
      const [obj] = (await buildFurniture({ ...plan, furniture: [piece] }, lib, clipLib, opts.resolveUrl, opts.modelInfo, opts.manager)).children;
      obj.position.y += level.elevation;
      obj.userData.piece = piece;
      editor!.remove(piece.id);
      (obj.userData.roof ? roofs : inOptions(obj, obj.userData.loose ? loose : fixtures)).add(obj);
      for (const o of [obj, ...optionGroups.values()]) if (o.userData.optionGroup) o.visible = shownInOption(o.userData, designOption);
      pieceMap.set(piece.id, obj);
      return obj;
    },
    remove(id) {
      pieceMap.get(id)?.removeFromParent();
      pieceMap.delete(id);
    },
    repaint(edited) {
      // Hand edits only ever add finishes, under new keys; a key reused after an undo is made again.
      const changed = new Set(lib.updateFinishes(edited));
      for (const variant of [...clipCache.keys()]) if (changed.has(variant.split('@')[0])) clipCache.delete(variant);
      for (const g of [walls, floors]) g.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (Array.isArray(mesh.material) && mesh.userData.surfaces) {
          mesh.material = mesh.material.map((m, i) => {
            const key = mesh.userData.surfaces[i] && surfaceFinish(edited, mesh.userData.surfaces[i]);
            return key ? clipLib(key) : m;
          });
        } else if (mesh.userData.surface) {
          const key = surfaceFinish(edited, mesh.userData.surface);
          if (key) mesh.material = lib.get(key);
        }
      });
    },
  } : null;

  return {
    root, walls, floors, caps, ceilings, lights, daylight, furniture, looseFurniture: loose, roofs, rooms, levels: builtLevels, parts, clipPlane, bounds: b, editor,
    get colliders() {
      return world(colliders, designOption);
    },
    get collidersFixed() {
      return world(collidersFixed, designOption);
    },
    get designOption() {
      return designOption;
    },
    setDesignOption(option) {
      if ((option?.id ?? null) === designOption) return;
      // Materials the old or the new option replaces: note what each key uses now, switch, then swap.
      const keys = [...new Set([...lib.optionKeys(), ...Object.keys(option?.materials ?? {})])];
      const before = keys.map((key) => ({ key, shared: lib.peek(key), copy: clipCache.get(clipVariant(key)) }));
      lib.applyDesignOption(option);
      for (const { key, shared, copy } of before) {
        if (shared) swap(shared, lib.get(key));
        if (copy) swap(copy, clipLib(key));
      }
      designOption = option?.id ?? null;
      showOption();
    },
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of clipCache.values()) m.dispose();
    },
  };
}
