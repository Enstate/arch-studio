import { expect, test } from 'bun:test';
import { addFurniture, applyEdits, furnitureId, NO_EDITS, paintSurfaces, placeFurniture, removeFurniture, type PlanEdits } from '../src/plan/edits.ts';
import { placementProblem, snapPlacement } from '../src/plan/placement.ts';
import { FURNITURE_DEFAULT_SIZE } from '../src/plan/furnitureSizes.ts';
import type { Furniture, Plan } from '../src/plan/schema.ts';
import { surfaceFinish } from '../src/plan/surfaces.ts';
import { validatePlan } from '../src/plan/validate.ts';

/** A 6 × 4 m living room: door in the south wall, window in the north, a sofa and a rug. */
const room = (): Plan => ({
  version: 1,
  name: 'Edits test',
  walls: [
    { id: 'n', a: [0, 0], b: [6, 0], exterior: true },
    { id: 'e', a: [6, 0], b: [6, 4], exterior: true },
    { id: 's', a: [6, 4], b: [0, 4], exterior: true },
    { id: 'w', a: [0, 4], b: [0, 0], exterior: true },
  ],
  openings: [
    { id: 'door', wall: 's', type: 'door', offset: 1, width: 0.9, swing: 'right' },
    { id: 'window', wall: 'n', type: 'window', offset: 3, width: 1.5 },
  ],
  rooms: [{ id: 'living', name: 'Living', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], floor: 'oak' }],
  furniture: [
    { id: 'sofa', type: 'sofa', room: 'living', position: [4.5, 2.5] },
    { id: 'rug', type: 'rug', room: 'living', position: [3, 2] },
  ],
  designOptions: [
    { id: 'nordic', name: 'Nordic', default: true },
    { id: 'warm', name: 'Warm', materials: { oak: { color: '#8a5a3a' } } },
  ],
});

const sizeOf = (f: Furniture) => f.size ?? FURNITURE_DEFAULT_SIZE[f.type];

test('edits move, turn, remove and add pieces over the plan, and applying them twice changes nothing', () => {
  const plan = room();
  let edits: PlanEdits = placeFurniture(NO_EDITS, 'sofa', [4, 3], 90);
  edits = removeFurniture(edits, 'rug');
  edits = addFurniture(edits, { id: furnitureId(plan, 'armchair'), type: 'armchair', room: 'living', position: [1.5, 1.5] });
  const once = applyEdits(plan, edits);
  expect(once.dropped).toEqual([]);
  expect(once.plan.furniture!.map((f) => [f.id, f.position, f.rotation])).toEqual([['sofa', [4, 3], 90], ['armchair-2', [1.5, 1.5], undefined]]);
  expect(applyEdits(once.plan, edits).plan).toEqual(once.plan);
  // The agent's plan itself is untouched.
  expect(plan.furniture!.length).toBe(2);
  expect(validatePlan(once.plan).filter((i) => i.level === 'error')).toEqual([]);
});

test('a hand-placed piece moves in place and is forgotten when removed', () => {
  let edits = addFurniture(NO_EDITS, { id: 'plant-2', type: 'plant', position: [1, 1] });
  edits = placeFurniture(edits, 'plant-2', [2, 1], 45);
  expect(edits.added).toEqual([{ id: 'plant-2', type: 'plant', position: [2, 1], rotation: 45 }]);
  expect(edits.furniture).toBeUndefined();
  expect(removeFurniture(edits, 'plant-2').added).toEqual([]);
});

test('edits whose piece, room or wall is gone are dropped and listed', () => {
  const edits: PlanEdits = { version: 1, furniture: { chair: { position: [1, 1] } }, surfaces: { 'wall:kitchen:n': '#ffffff', 'floor:living': '#eeeeee' } };
  const { plan, dropped } = applyEdits(room(), edits);
  expect(dropped).toHaveLength(2);
  expect(dropped[0]).toContain('furniture chair');
  expect(dropped[1]).toContain('surface wall:kitchen:n');
  expect(plan.rooms![0].floor).toBe('#eeeeee');
});

test('painting gives one surface its own finish and leaves the rest of the old one alone', () => {
  const plan = room();
  plan.rooms!.push({ id: 'hall', name: 'Hall', polygon: [[6, 0], [8, 0], [8, 4], [6, 4]], floor: 'oak' });
  const edits = paintSurfaces(NO_EDITS, plan, ['wall:living:n'], { color: '#c96f4a' }, 'nordic');
  const { plan: painted } = applyEdits(plan, edits);
  expect(surfaceFinish(painted, 'wall:living:n')).toBe('paint-1');
  expect(surfaceFinish(painted, 'wall:living:e')).toBe('paint-white');
  expect(painted.materials!['paint-1'].color).toBe('#c96f4a');
  // Shift+drop: every surface that had the old floor gets the new one together.
  const both = paintSurfaces(edits, painted, ['floor:living', 'floor:hall'], { color: '#dddddd' }, 'nordic');
  const floors = applyEdits(plan, both).plan;
  expect(surfaceFinish(floors, 'floor:hall')).toBe('paint-2');
  expect(surfaceFinish(floors, 'floor:living')).toBe('paint-2');
});

test('painting in a look that replaces the old finish keeps the other looks as they were', () => {
  const plan = room();
  // Warm replaces oak; Nordic uses the plan's oak.
  const edits = paintSurfaces(NO_EDITS, plan, ['floor:living'], { color: '#222222' }, 'warm');
  const { plan: painted } = applyEdits(plan, edits);
  expect(painted.materials!['paint-1']).toEqual({ color: '#c49a6c', pattern: 'planks', module: [1.4, 0.19], seam: '#8a6440', roughness: 0.55 });
  expect(painted.designOptions![1].materials!['paint-1'].color).toBe('#222222');
  // Painting in Nordic changes the shared finish, and Warm keeps its own copy of the old one.
  const nordic = paintSurfaces(NO_EDITS, plan, ['floor:living'], { color: '#eeeeee' }, 'nordic');
  const shared = applyEdits(plan, nordic).plan;
  expect(shared.materials!['paint-1'].color).toBe('#eeeeee');
  expect(shared.designOptions![1].materials!['paint-1'].color).toBe('#8a5a3a');
});

test('repainting a surface drops the finish nothing uses any more', () => {
  const plan = room();
  const first = paintSurfaces(NO_EDITS, plan, ['floor:living'], { color: '#111111' }, null);
  const second = paintSurfaces(first, applyEdits(plan, first).plan, ['floor:living'], { color: '#222222' }, null);
  expect(Object.keys(second.materials!)).toEqual(['paint-2']);
});

test('a dragged piece snaps to the 10 cm grid and goes flush against a wall it comes near', () => {
  const plan = room();
  expect(snapPlacement(plan, [2.43, 2.06], 0, [0.85, 0.85, 0.8])).toEqual([2.4, 2.1]);
  // 0.1 m from the inside face of the east wall (x 5.85): pushed flush, the centre at 5.85 − 0.425.
  const [x] = snapPlacement(plan, [5.33, 2], 0, [0.85, 0.85, 0.8]);
  expect(x).toBeCloseTo(5.425, 3);
});

test('pieces may not overlap each other, walls, a door swing or a window above its sill, but rugs go under', () => {
  const plan = room();
  const check = (type: Furniture['type'], position: [number, number], rotation = 0) =>
    placementProblem(plan, { id: 'new', type, position, rotation, size: FURNITURE_DEFAULT_SIZE[type] }, sizeOf, 'nordic');
  expect(check('armchair', [4.5, 2.4])).toEqual({ kind: 'furniture', id: 'sofa' });
  expect(check('armchair', [2, 1.5])).toBeNull();
  expect(check('rug', [4.5, 2.5])).toBeNull();
  expect(check('armchair', [5.9, 1.2])).toEqual({ kind: 'wall', id: 'e' });
  // The door at x 4.55 to 5.45 swings into the room.
  expect(check('armchair', [5, 3.4])).toEqual({ kind: 'door', id: 'door' });
  // A bookshelf in front of the window reaches above its sill; a low tv unit does not.
  expect(check('bookshelf', [3, 0.35])).toEqual({ kind: 'window', id: 'window' });
  expect(check('tv-unit', [3, 0.4])).toBeNull();
});

test('a piece that only belongs to another look is not in the way', () => {
  const plan = room();
  plan.furniture![0].designOptions = ['warm'];
  expect(placementProblem(plan, { id: 'new', type: 'armchair', position: [4.5, 2.4], rotation: 0, size: FURNITURE_DEFAULT_SIZE.armchair }, sizeOf, 'nordic')).toBeNull();
});
