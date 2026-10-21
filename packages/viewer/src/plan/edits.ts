import type { Furniture, MaterialDef, Plan, Vec2 } from './schema.ts';
import { BUILTIN } from './finishes.ts';
import { paintSurface, surfaceFinish } from './surfaces.ts';

/**
 * Changes a person made by hand in the viewer, kept apart from the agent's plan in
 * `source/edits.json` and laid over it on every build. Every entry states a result, not a step,
 * so applying the same edits to a plan that already has them changes nothing.
 */
export interface PlanEdits {
  version: 1;
  /** Pieces of the plan that moved, turned or went, by id. */
  furniture?: Record<string, FurnitureEdit>;
  /** Pieces placed by hand, whole. */
  added?: Furniture[];
  /** Surface id (see `surfaceOf`) to the material key it now uses. */
  surfaces?: Record<string, string>;
  /** Finishes the painting made, by material key. */
  materials?: Record<string, MaterialDef>;
  /** The same keys' finishes in particular design options, by option id. */
  designOptions?: Record<string, Record<string, MaterialDef>>;
}

export interface FurnitureEdit {
  position?: Vec2;
  rotation?: number;
  removed?: true;
}

export const NO_EDITS: PlanEdits = { version: 1 };

/** Prefix of the material keys painting makes, so they never collide with the agent's. */
const PAINT = 'paint-';

export const hasEdits = (e: PlanEdits) =>
  !!(Object.keys(e.furniture ?? {}).length || e.added?.length || Object.keys(e.surfaces ?? {}).length);

/**
 * The plan with the edits laid over it, and a line for each edit whose piece, room or wall is
 * gone, so the person and the agent can see what no longer applies.
 */
export function applyEdits(plan: Plan, edits: PlanEdits): { plan: Plan; dropped: string[] } {
  const out = structuredClone(plan);
  const dropped: string[] = [];
  out.furniture ??= [];
  for (const [id, e] of Object.entries(edits.furniture ?? {})) {
    const i = out.furniture.findIndex((f) => f.id === id);
    if (i < 0) {
      dropped.push(`furniture ${id}: ${e.removed ? 'removed' : 'moved'} by hand, no longer in the plan`);
      continue;
    }
    if (e.removed) out.furniture.splice(i, 1);
    else Object.assign(out.furniture[i], e.position && { position: e.position }, e.rotation !== undefined && { rotation: e.rotation });
  }
  const levels = new Set(out.levels?.map((l) => l.id));
  for (const piece of edits.added ?? []) {
    if (piece.level && !levels.has(piece.level)) {
      dropped.push(`furniture ${piece.id}: placed by hand on level ${piece.level}, which no longer exists`);
      continue;
    }
    const placed = structuredClone(piece);
    if (placed.room && !out.rooms?.some((r) => r.id === placed.room)) delete placed.room;
    const i = out.furniture.findIndex((f) => f.id === piece.id);
    if (i >= 0) out.furniture[i] = placed;
    else out.furniture.push(placed);
  }
  if (edits.materials) out.materials = { ...out.materials, ...structuredClone(edits.materials) };
  for (const [id, materials] of Object.entries(edits.designOptions ?? {})) {
    const option = out.designOptions?.find((o) => o.id === id);
    if (option) option.materials = { ...option.materials, ...structuredClone(materials) };
  }
  for (const [surface, key] of Object.entries(edits.surfaces ?? {})) {
    if (!paintSurface(out, surface, key)) dropped.push(`surface ${surface}: painted by hand, no longer in the plan`);
  }
  if (!out.furniture.length) delete out.furniture;
  return { plan: out, dropped };
}

const added = (edits: PlanEdits, id: string) => edits.added?.findIndex((f) => f.id === id) ?? -1;

/** Moves or turns a piece, whether the agent made it or someone placed it. */
export function placeFurniture(edits: PlanEdits, id: string, position: Vec2, rotation: number): PlanEdits {
  const i = added(edits, id);
  if (i >= 0) return { ...edits, added: edits.added!.map((f, j) => (j === i ? { ...f, position, rotation } : f)) };
  return { ...edits, furniture: { ...edits.furniture, [id]: { position, rotation } } };
}

/** Takes a piece out: a hand-placed one is forgotten, an agent's one is marked removed. */
export function removeFurniture(edits: PlanEdits, id: string): PlanEdits {
  const i = added(edits, id);
  if (i >= 0) return { ...edits, added: edits.added!.filter((_, j) => j !== i) };
  return { ...edits, furniture: { ...edits.furniture, [id]: { removed: true } } };
}

export function addFurniture(edits: PlanEdits, piece: Furniture): PlanEdits {
  return { ...edits, added: [...(edits.added ?? []), piece] };
}

/** A readable id for a new piece of a type, unused in the plan: `armchair-2`, `plant-3`. */
export function furnitureId(plan: Plan, base: string) {
  const name = base.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'piece';
  const taken = new Set(plan.furniture?.map((f) => f.id));
  for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`;
}

/** The plan's own finish for a key, before any design option. */
export function planFinish(plan: Plan, key: string): MaterialDef | undefined {
  if (/^#[0-9a-f]{3,6}$/i.test(key)) return { color: key, roughness: 0.6 };
  return plan.materials?.[key] ?? BUILTIN[key];
}

/**
 * Paints surfaces with a new finish in the look on show. Each paint makes its own material key,
 * so nothing else that used the old finish changes. A look that replaces the old finish keeps
 * its own copy, and only the look on show gets the new one when it replaced the old finish too.
 * `plan` is the plan as currently edited.
 */
export function paintSurfaces(edits: PlanEdits, plan: Plan, surfaces: string[], finish: MaterialDef, look: string | null): PlanEdits {
  const used = new Set([...Object.keys(plan.materials ?? {}), ...Object.keys(edits.materials ?? {})]);
  let n = 1;
  while (used.has(`${PAINT}${n}`)) n++;
  const key = `${PAINT}${n}`;
  // Surfaces painted together share the finish they had, as with Shift+drop; the first one decides.
  const old = surfaceFinish(plan, surfaces[0]);
  const options = plan.designOptions ?? [];
  const overrides = (id: string) => (old ? options.find((o) => o.id === id)?.materials?.[old] : undefined);
  const lookOverrides = !!(look && overrides(look));
  const base = lookOverrides ? (old ? planFinish(plan, old) : undefined) ?? finish : finish;
  const designOptions = { ...edits.designOptions };
  for (const option of options) {
    const own = option.id === look && lookOverrides ? finish : overrides(option.id);
    if (own) designOptions[option.id] = { ...designOptions[option.id], [key]: structuredClone(own) };
  }
  return withoutUnusedPaint({
    ...edits,
    materials: { ...edits.materials, [key]: structuredClone(base) },
    ...(Object.keys(designOptions).length && { designOptions }),
    surfaces: { ...edits.surfaces, ...Object.fromEntries(surfaces.map((s) => [s, key])) },
  });
}

/** Drops paint finishes that no surface uses any more, after a surface was painted over. */
function withoutUnusedPaint(edits: PlanEdits): PlanEdits {
  const used = new Set([...Object.values(edits.surfaces ?? {}), ...(edits.added ?? []).flatMap((f) => [f.material, f.accent])]);
  const keep = (materials: Record<string, MaterialDef>) =>
    Object.fromEntries(Object.entries(materials).filter(([key]) => !key.startsWith(PAINT) || used.has(key)));
  return {
    ...edits,
    ...(edits.materials && { materials: keep(edits.materials) }),
    ...(edits.designOptions && { designOptions: Object.fromEntries(Object.entries(edits.designOptions).map(([id, m]) => [id, keep(m)])) }),
  };
}
