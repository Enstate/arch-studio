import type { Furniture, Plan, Vec2 } from './schema.ts';
import { withDefaults } from './schema.ts';
import { add, dot, scale, sub, wallDir, wallLeft, wallLength, wallThickness } from './geom.ts';
import { shownInOption } from './options.ts';

/** Grid a dragged piece snaps to, in metres. */
export const SNAP_GRID = 0.1;
/** A piece this close to a wall face goes flush against it. */
export const WALL_SNAP = 0.15;
/** Turn per wheel step while a piece is held or selected, in degrees. */
export const TURN_STEP = 15;
/** Overlap two outlines may have before they count as touching, so flush pieces fit. */
const TOUCH = 0.01;
/** Free depth in front of a window that only pieces below its sill may take. */
const WINDOW_REACH = 0.25;
/** Free depth on both sides of a doorway without a hinged leaf. */
const PASSAGE = 0.5;

/** Corners of a piece's outline in plan coordinates, from its centre, turn and [width, depth]. */
export function footprint([x, y]: Vec2, rotation: number, [w, d]: readonly number[]): Vec2[] {
  // Clockwise on screen with y down, as the builder turns pieces.
  const r = (rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]): Vec2 => {
    const lx = (sx * w) / 2, ly = (sy * d) / 2;
    return [x + lx * c - ly * s, y + lx * s + ly * c];
  });
}

const rect = (a: Vec2, b: Vec2, n: Vec2, from: number, to: number): Vec2[] => [add(a, scale(n, from)), add(b, scale(n, from)), add(b, scale(n, to)), add(a, scale(n, to))];

/** How deep two convex outlines overlap along their narrowest separating axis; 0 or less is apart. */
function overlap(p: Vec2[], q: Vec2[]) {
  let least = Infinity;
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i]);
      const axis: Vec2 = [-e[1], e[0]];
      const l = Math.hypot(axis[0], axis[1]) || 1;
      const span = (pts: Vec2[]) => pts.map((v) => dot(v, axis) / l);
      const a = span(p), b = span(q);
      least = Math.min(least, Math.min(Math.max(...a), Math.max(...b)) - Math.max(Math.min(...a), Math.min(...b)));
    }
  }
  return least;
}

/**
 * Where a dragged piece lands: its centre on the 10 cm grid, then pushed flush against a wall
 * face it comes within 15 cm of. `storey` holds the walls of the piece's floor.
 */
export function snapPlacement(storey: Plan, position: Vec2, rotation: number, size: readonly number[]): Vec2 {
  let p: Vec2 = [Math.round(position[0] / SNAP_GRID) * SNAP_GRID, Math.round(position[1] / SNAP_GRID) * SNAP_GRID];
  let best: Vec2 | null = null, bestGap = WALL_SNAP;
  for (const w of storey.walls) {
    const dir = wallDir(w), L = wallLength(w), half = wallThickness(storey, w) / 2;
    for (const side of [1, -1]) {
      const n = scale(wallLeft(w), side);
      const corners = footprint(p, rotation, size);
      const along = corners.map((c) => dot(sub(c, w.a), dir));
      if (Math.max(...along) < 0 || Math.min(...along) > L) continue;
      // Distance of the nearest corner from the face, outward from the wall.
      const gap = Math.min(...corners.map((c) => dot(sub(c, w.a), n))) - half;
      if (Math.abs(gap) < bestGap && Math.max(...corners.map((c) => dot(sub(c, w.a), n))) > half) {
        bestGap = Math.abs(gap);
        best = scale(n, -gap);
      }
    }
  }
  if (best) p = add(p, best);
  return [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
}

/**
 * The nearest spot to `near` where a piece is `free` to stand, after `snap`: rings of candidates
 * 10 cm apart, out to a metre and a half. Null when there is none.
 */
export function nearestFreeSpot(near: Vec2, snap: (position: Vec2) => Vec2, free: (position: Vec2) => boolean): Vec2 | null {
  for (let r = 0; r <= 15; r++) {
    const ring = r === 0 ? [[0, 0]] : Array.from({ length: 8 * r }, (_, i) => {
      const a = (i / (8 * r)) * Math.PI * 2;
      return [Math.cos(a) * r * 0.1, Math.sin(a) * r * 0.1];
    });
    for (const [dx, dy] of ring) {
      const at = snap([near[0] + dx!, near[1] + dy!]);
      if (free(at)) return at;
    }
  }
  return null;
}

export type PlacementProblem =
  | { kind: 'furniture'; id: string }
  | { kind: 'wall' | 'door' | 'window'; id: string };

/** A piece as it would stand: its outline and the heights it takes. */
export interface Placed {
  id: string;
  type: Furniture['type'];
  position: Vec2;
  rotation: number;
  /** [width, depth, height]. */
  size: readonly number[];
  elevation?: number;
}

/** Rugs and other flat pieces lie under furniture without counting as in the way. */
const flat = (type: string, height: number) => type === 'rug' || height <= 0.03;

/**
 * What a piece would run into where it stands, if anything: another piece in the look on show,
 * a wall, the swing of a door or the free space of a doorway, or a window it would stand in
 * front of above the sill. Rugs and other flat pieces only meet walls. `storey` holds the piece's floor; `sizeOf` gives other pieces' sizes.
 */
export function placementProblem(storey: Plan, piece: Placed, sizeOf: (f: Furniture) => readonly number[], look: string | null): PlacementProblem | null {
  const outline = footprint(piece.position, piece.rotation, piece.size);
  const low = piece.elevation ?? 0, high = low + piece.size[2];
  if (!flat(piece.type, piece.size[2]))
    for (const f of storey.furniture ?? []) {
      if (f.id === piece.id || f.roof || !shownInOption(f, look)) continue;
      const size = sizeOf(f);
      const fLow = f.elevation ?? 0;
      if (flat(f.type, size[2]) || fLow >= high - TOUCH || fLow + size[2] <= low + TOUCH) continue;
      if (overlap(outline, footprint(f.position, f.rotation ?? 0, size)) > TOUCH) return { kind: 'furniture', id: f.id };
    }
  const d = withDefaults(storey);
  for (const w of storey.walls) {
    const n = wallLeft(w), half = wallThickness(storey, w) / 2;
    if (overlap(outline, rect(w.a, w.b, n, -half, half)) > TOUCH) return { kind: 'wall', id: w.id };
  }
  // A door sweeps over a rug and a rug never blocks a window.
  if (flat(piece.type, piece.size[2])) return null;
  for (const o of storey.openings ?? []) {
    const w = storey.walls.find((wall) => wall.id === o.wall);
    if (!w) continue;
    const dir = wallDir(w), n = wallLeft(w), half = wallThickness(storey, w) / 2;
    const a = add(w.a, scale(dir, o.offset - o.width / 2)), b = add(w.a, scale(dir, o.offset + o.width / 2));
    if (o.type === 'window') {
      const sill = o.sill ?? d.windowSill, top = sill + (o.height ?? d.windowHeight);
      if (high <= sill + TOUCH || low >= top - TOUCH) continue;
      for (const side of [1, -1]) {
        if (overlap(outline, rect(a, b, scale(n, side), half, half + WINDOW_REACH)) > TOUCH) return { kind: 'window', id: o.id };
      }
      continue;
    }
    if (o.type === 'door' || o.type === 'double-door') {
      // The leaf sweeps a square as deep as it is wide on the side it opens to; right is the default.
      const toward = scale(n, o.swing === 'left' ? 1 : -1);
      const reach = o.type === 'double-door' ? o.width / 2 : o.width;
      if (overlap(outline, rect(a, b, toward, half, half + reach)) > TOUCH) return { kind: 'door', id: o.id };
      continue;
    }
    for (const side of [1, -1]) {
      if (overlap(outline, rect(a, b, scale(n, side), half, half + PASSAGE)) > TOUCH) return { kind: 'door', id: o.id };
    }
  }
  return null;
}
