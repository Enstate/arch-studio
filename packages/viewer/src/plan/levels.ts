import type { CameraDef, Level, Plan, Vec2 } from './schema.ts';
import { withDefaults } from './schema.ts';
import { FURNITURE_DEFAULT_SIZE } from './furnitureSizes.ts';

/** The single storey of a plan without `levels`. */
const GROUND: Level = { id: '', name: '', elevation: 0 };

/** Storeys bottom to top. A plan without `levels` has one, at the ground. */
export function levels(plan: Plan): Level[] {
  return plan.levels?.length ? [...plan.levels].sort((a, b) => a.elevation - b.elevation) : [GROUND];
}

/** The storey an element names, or the lowest one. */
export function levelOf(plan: Plan, id: string | undefined): Level {
  const all = levels(plan);
  return all.find((l) => l.id === id) ?? all[0];
}

/** The storey a point at height `y` stands on: the highest floor at most half a metre above it. */
export function levelAt(plan: Plan, y: number): Level {
  const all = levels(plan);
  return [...all].reverse().find((l) => l.elevation <= y + 0.5) ?? all[0];
}

/**
 * One storey as a plan of its own, measured from its floor. Geometry, finishes and room lookups
 * then only ever see the walls and rooms they share a floor with.
 */
export function levelPlan(plan: Plan, level: Level): Plan {
  if (!plan.levels?.length) return plan;
  const lowest = levels(plan)[0];
  const on = (id: string | undefined) => (id ?? lowest.id) === level.id;
  const walls = plan.walls.filter((w) => on(w.level));
  const wallIds = new Set(walls.map((w) => w.id));
  return {
    ...plan,
    levels: undefined,
    defaults: { ...plan.defaults, wallHeight: level.height ?? withDefaults(plan).wallHeight },
    walls,
    openings: plan.openings?.filter((o) => wallIds.has(o.wall)),
    rooms: plan.rooms?.filter((r) => on(r.level)),
    furniture: plan.furniture?.filter((f) => on(f.level)),
    cameras: plan.cameras?.filter((c) => on(c.level)),
  };
}

/** A flight of stairs in plan coordinates and absolute heights. */
export interface StairFlight {
  id: string;
  level: Level;
  /** Corners of the footprint in plan coordinates. */
  footprint: Vec2[];
  /** Height of the bottom and the top tread above the ground floor. */
  base: number;
  top: number;
}

export function stairFlights(plan: Plan): StairFlight[] {
  return (plan.furniture ?? []).filter((f) => f.type === 'stairs').map((f) => {
    const level = levelOf(plan, f.level);
    const [w, d, h] = f.size ?? FURNITURE_DEFAULT_SIZE.stairs;
    // Plan rotation turns clockwise on screen, where y points down.
    const a = ((f.rotation ?? 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const footprint = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sz]): Vec2 => {
      const x = (sx * w) / 2, z = (sz * d) / 2;
      return [f.position[0] + x * cos - z * sin, f.position[1] + x * sin + z * cos];
    });
    const base = level.elevation + (f.elevation ?? 0);
    return { id: f.id, level, footprint, base, top: base + h };
  });
}

/** Where a fixed camera stands and looks, as world [x, y, z] with y up. */
export function cameraView(plan: Plan, camera: CameraDef) {
  const floor = levelOf(plan, camera.level).elevation;
  return {
    position: [camera.position[0], floor + (camera.height ?? 1.6), camera.position[1]] as [number, number, number],
    target: [camera.lookAt[0], floor + (camera.lookAtHeight ?? 1.2), camera.lookAt[1]] as [number, number, number],
  };
}
