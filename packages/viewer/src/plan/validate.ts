import type { Plan, Vec2 } from './schema.ts';
import { withDefaults } from './schema.ts';
import {
  EPS, dist, planBounds, pointInPolygon, pointSegment, polygonSelfIntersects, roomNetArea,
  wallHeight, wallLength, wallThickness, wallDir, cross, sub, dot,
} from './geom.ts';
import { FURNITURE_DEFAULT_SIZE } from './furnitureSizes.ts';

export interface Issue {
  level: 'error' | 'warn';
  where: string;
  message: string;
}

const isVec2 = (v: unknown): v is Vec2 =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * Checks a plan for mistakes that would break the build or betray a misread
 * plan: dangling walls, openings that don't fit, room areas that disagree
 * with the printed labels, furniture outside its room.
 */
export function validatePlan(plan: Plan): Issue[] {
  const issues: Issue[] = [];
  const err = (where: string, message: string) => issues.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => issues.push({ level: 'warn', where, message });
  const d = withDefaults(plan);

  if (plan.version !== 1) err('plan', `version must be 1, got ${String(plan.version)}`);
  if (!Array.isArray(plan.walls) || plan.walls.length === 0) {
    err('plan', 'needs at least one wall');
    return issues;
  }

  const ids = new Map<string, string>();
  const claim = (id: string, kind: string) => {
    if (!id) err(kind, 'missing id');
    else if (ids.has(id)) err(`${kind} ${id}`, `id already used by a ${ids.get(id)}`);
    else ids.set(id, kind);
  };

  // Walls
  for (const w of plan.walls) {
    claim(w.id, 'wall');
    if (!isVec2(w.a) || !isVec2(w.b)) {
      err(`wall ${w.id}`, 'a and b must be [x, y] number pairs');
      continue;
    }
    const L = wallLength(w);
    if (L < 0.05) err(`wall ${w.id}`, `is ${L.toFixed(3)} m long`);
    const t = wallThickness(plan, w);
    if (t < 0.05 || t > 0.8) warn(`wall ${w.id}`, `thickness ${t} m looks wrong (expected 0.08 to 0.5)`);
    const ang = (Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]) * 180) / Math.PI;
    const off = Math.abs(((ang % 90) + 90) % 90);
    if (off > 0.3 && off < 89.7 && Math.min(off, 90 - off) < 3)
      warn(`wall ${w.id}`, `is ${Math.min(off, 90 - off).toFixed(1)}° off axis. Probably a tracing error; snap it.`);
    for (const [end, p] of [['a', w.a], ['b', w.b]] as const) {
      const touches = plan.walls.some((o) => o !== w && pointSegment(p, o.a, o.b).d < EPS);
      if (!touches) warn(`wall ${w.id}`, `end ${end} [${p.join(', ')}] connects to no other wall`);
    }
  }

  // Overlapping collinear walls draw twice and z-fight.
  for (let i = 0; i < plan.walls.length; i++) {
    for (let j = i + 1; j < plan.walls.length; j++) {
      const A = plan.walls[i], B = plan.walls[j];
      const dA = wallDir(A);
      if (Math.abs(cross(dA, wallDir(B))) > 0.01) continue; // not parallel
      if (Math.abs(cross(sub(B.a, A.a), dA)) > EPS) continue; // parallel but on another line
      const ta = [dot(sub(B.a, A.a), dA), dot(sub(B.b, A.a), dA)].sort((x, y) => x - y);
      const overlap = Math.min(ta[1], wallLength(A)) - Math.max(ta[0], 0);
      if (overlap > EPS) err(`wall ${A.id} / ${B.id}`, `overlap by ${overlap.toFixed(2)} m along the same line`);
    }
  }

  // Openings
  const byWall = new Map<string, { id: string; s: number; e: number }[]>();
  for (const o of plan.openings ?? []) {
    claim(o.id, 'opening');
    const w = plan.walls.find((x) => x.id === o.wall);
    if (!w) {
      err(`opening ${o.id}`, `wall "${o.wall}" does not exist`);
      continue;
    }
    const L = wallLength(w);
    const s = o.offset - o.width / 2;
    const e = o.offset + o.width / 2;
    if (o.width <= 0.2) err(`opening ${o.id}`, `width ${o.width} m is too small`);
    if (s < 0.05 || e > L - 0.05)
      err(`opening ${o.id}`, `spans ${s.toFixed(2)} to ${e.toFixed(2)} m but wall ${w.id} is ${L.toFixed(2)} m long`);
    const isWindow = o.type === 'window';
    const sill = isWindow ? (o.sill ?? d.windowSill) : 0;
    const h = o.height ?? (isWindow ? d.windowHeight : o.type === 'garage-door' ? 2.2 : d.doorHeight);
    if (sill + h > wallHeight(plan, w) - 0.05)
      err(`opening ${o.id}`, `top at ${(sill + h).toFixed(2)} m reaches the ${wallHeight(plan, w)} m wall top`);
    if (o.type === 'door' && (o.width < 0.6 || o.width > 1.2)) warn(`opening ${o.id}`, `door width ${o.width} m is unusual`);
    const list = byWall.get(w.id) ?? [];
    for (const other of list)
      if (s < other.e - 0.02 && e > other.s + 0.02) err(`opening ${o.id}`, `overlaps opening ${other.id} on wall ${w.id}`);
    list.push({ id: o.id, s, e });
    byWall.set(w.id, list);
  }

  // Rooms
  for (const r of plan.rooms ?? []) {
    claim(r.id, 'room');
    if (!Array.isArray(r.polygon) || r.polygon.length < 3 || !r.polygon.every(isVec2)) {
      err(`room ${r.id}`, 'polygon needs at least 3 [x, y] points');
      continue;
    }
    if (dist(r.polygon[0], r.polygon[r.polygon.length - 1]) < EPS)
      warn(`room ${r.id}`, 'last point repeats the first; drop it');
    if (polygonSelfIntersects(r.polygon)) err(`room ${r.id}`, 'polygon crosses itself');
    const area = roomNetArea(plan, r.polygon);
    if (area < 1) err(`room ${r.id}`, `net area is only ${area.toFixed(2)} m²`);
    if (r.areaLabel) {
      const diff = (area - r.areaLabel) / r.areaLabel;
      if (Math.abs(diff) > 0.08)
        warn(`room ${r.id}`, `area ${area.toFixed(2)} m² vs ${r.areaLabel} m² on the plan (${(diff * 100).toFixed(0)}%). Check the scale or the polygon.`);
    }
  }

  // Furniture
  for (const f of plan.furniture ?? []) {
    claim(f.id, 'furniture');
    if (f.fixture !== undefined && typeof f.fixture !== 'boolean') err(`furniture ${f.id}`, 'fixture must be a boolean');
    if (!isVec2(f.position)) {
      err(`furniture ${f.id}`, 'position must be [x, y]');
      continue;
    }
    if (!(f.type in FURNITURE_DEFAULT_SIZE)) err(`furniture ${f.id}`, `unknown type "${f.type}"`);
    if (f.room) {
      const room = plan.rooms?.find((r) => r.id === f.room);
      if (!room) err(`furniture ${f.id}`, `room "${f.room}" does not exist`);
      else if (!pointInPolygon(f.position, room.polygon)) warn(`furniture ${f.id}`, `center is outside room ${room.id}`);
    }
    if (f.type === 'rug' || f.type === 'stairs') continue;
    const [fw, fd] = f.size ?? FURNITURE_DEFAULT_SIZE[f.type] ?? [0.5, 0.5, 0.5];
    const r = Math.min(fw, fd) / 2;
    for (const w of plan.walls) {
      const { d: dd } = pointSegment(f.position, w.a, w.b);
      if (dd + 0.01 < r * 0.6 + wallThickness(plan, w) / 2) {
        warn(`furniture ${f.id}`, `sits inside wall ${w.id}`);
        break;
      }
    }
  }

  // Cameras
  for (const c of plan.cameras ?? []) {
    claim(c.id, 'camera');
    if (!isVec2(c.position) || !isVec2(c.lookAt)) err(`camera ${c.id}`, 'position and lookAt must be [x, y]');
    else if (dist(c.position, c.lookAt) < 0.1) err(`camera ${c.id}`, 'lookAt is on top of position');
  }

  // Overall size against the printed dimensions
  if (plan.source?.overall) {
    const b = planBounds(plan);
    // Bounds use centerlines; the printed overall size is to the outside faces.
    const t = d.exteriorThickness;
    const [ow, oh] = plan.source.overall;
    const dw = b.w + t - ow;
    const dh = b.h + t - oh;
    if (Math.abs(dw) > 0.1 || Math.abs(dh) > 0.1)
      warn('plan', `outside size ${(b.w + t).toFixed(2)} × ${(b.h + t).toFixed(2)} m vs printed ${ow} × ${oh} m`);
  }

  return issues;
}

export function summarize(plan: Plan) {
  const b = planBounds(plan);
  const rooms = plan.rooms ?? [];
  const area = rooms.reduce((s, r) => s + roomNetArea(plan, r.polygon), 0);
  return {
    walls: plan.walls.length,
    openings: plan.openings?.length ?? 0,
    rooms: rooms.length,
    furniture: plan.furniture?.length ?? 0,
    cameras: plan.cameras?.length ?? 0,
    footprint: `${b.w.toFixed(2)} × ${b.h.toFixed(2)} m`,
    roomArea: `${area.toFixed(1)} m²`,
  };
}
