import type { Vec2, Wall, Plan, Room } from './schema.ts';
import { withDefaults } from './schema.ts';

export const EPS = 0.02; // 2 cm: tolerance for "these points are the same corner"

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => len(sub(a, b));
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};

export function wallLength(w: Wall) {
  return dist(w.a, w.b);
}

/** Unit direction a to b. */
export function wallDir(w: Wall): Vec2 {
  return norm(sub(w.b, w.a));
}

/** Unit normal pointing to the left of a-to-b in plan view (y down). */
export function wallLeft(w: Wall): Vec2 {
  const d = wallDir(w);
  // With y pointing down, "left" of travel direction (dx, dy) is (dy, -dx).
  return [d[1], -d[0]];
}

export function wallThickness(plan: Plan, w: Wall) {
  const d = withDefaults(plan);
  return w.thickness ?? (w.exterior ? d.exteriorThickness : d.interiorThickness);
}

export function wallHeight(plan: Plan, w: Wall) {
  return w.height ?? withDefaults(plan).wallHeight;
}

/** Distance from point p to segment ab, and the parameter t along it (0..1). */
export function pointSegment(p: Vec2, a: Vec2, b: Vec2) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab) || 1e-9;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const q = add(a, scale(ab, t));
  return { d: dist(p, q), t, q };
}

export function polygonArea(poly: Vec2[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let cx = 0, cy = 0, s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * c;
    cy += (a[1] + b[1]) * c;
    s += c;
  }
  if (Math.abs(s) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((v, p) => v + p[0], 0) / n, poly.reduce((v, p) => v + p[1], 0) / n];
  }
  return [cx / (3 * s), cy / (3 * s)];
}

export function pointInPolygon(p: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

export function polygonSelfIntersects(poly: Vec2[]) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Bounding box of all wall endpoints. */
export function planBounds(plan: Plan) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of plan.walls) {
    for (const p of [w.a, w.b]) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 10, maxY: 10, w: 10, h: 10, cx: 5, cy: 5 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * How far a wall end has to reach past its centerline endpoint so it meets
 * the walls it connects to without a gap: half the thickest wall that
 * touches that end. Ends that touch nothing stay flush.
 */
export function wallEndExtensions(plan: Plan, w: Wall): [number, number] {
  const ext: [number, number] = [0, 0];
  [w.a, w.b].forEach((p, i) => {
    for (const o of plan.walls) {
      if (o === w) continue;
      const { d } = pointSegment(p, o.a, o.b);
      if (d < EPS) {
        // Skip collinear continuations: extending into them would only create overlap.
        const c = Math.abs(cross(wallDir(w), wallDir(o)));
        if (c < 0.05) continue;
        ext[i] = Math.max(ext[i], wallThickness(plan, o) / 2);
      }
    }
  });
  return ext;
}

/** Unit plan direction a sloped ceiling rises toward: degrees clockwise from the top of the plan (−y). */
export function slopeDirection(toward: number): Vec2 {
  const a = (toward * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

/** Height of a room's ceiling above its floor at plan point `p`; flat unless the room sets `ceilingSlope`. */
export function ceilingAt(plan: Plan, room: Room, p: Vec2) {
  const base = room.ceilingHeight ?? withDefaults(plan).wallHeight;
  const slope = room.ceilingSlope;
  if (!slope) return base;
  const dir = slopeDirection(slope.toward);
  const run = (q: Vec2) => q[0] * dir[0] + q[1] * dir[1];
  const from = slope.from ? run(slope.from) : Math.min(...room.polygon.map(run));
  return base + slope.rise * (run(p) - from);
}

/** A room has a ceiling only on a storey with walls, unless it opts out; `plan` is that storey. */
export function hasCeiling(plan: Plan, room: Room) {
  return plan.walls.length > 0 && room.ceiling !== false;
}

/** Which room, if any, contains a point. Smallest room wins so nested polygons work. */
export function roomAt(plan: Plan, p: Vec2) {
  let best: { id: string; area: number } | null = null;
  for (const r of plan.rooms ?? []) {
    if (!pointInPolygon(p, r.polygon)) continue;
    const area = polygonArea(r.polygon);
    if (!best || area < best.area) best = { id: r.id, area };
  }
  return best ? plan.rooms!.find((r) => r.id === best!.id)! : undefined;
}

/**
 * Floor area inside the walls. Room polygons usually follow wall
 * centerlines, while plans print net areas measured to the wall faces,
 * so each polygon edge that runs along a wall loses half that wall's thickness.
 */
export function roomNetArea(plan: Plan, poly: Vec2[]) {
  let area = polygonArea(poly);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const wall = plan.walls.find((w) => pointSegment(mid, w.a, w.b).d < EPS);
    if (wall) area -= dist(a, b) * (wallThickness(plan, wall) / 2);
  }
  return area;
}
