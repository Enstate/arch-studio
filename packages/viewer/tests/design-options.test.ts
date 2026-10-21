import { afterEach, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { buildHouse } from '../src/build/house.ts';
import { BUILTIN, MaterialLibrary } from '../src/build/materials.ts';
import type { Plan } from '../src/plan/schema.ts';
import { validatePlan } from '../src/plan/validate.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** One room with a shared table and a cabinet per look; each look sets its own floor. */
const styled = (): Plan => ({
  version: 1,
  name: 'Design options test',
  walls: [
    { id: 'n', a: [0, 0], b: [6, 0], exterior: true },
    { id: 'e', a: [6, 0], b: [6, 4], exterior: true },
    { id: 's', a: [6, 4], b: [0, 4], exterior: true },
    { id: 'w', a: [0, 4], b: [0, 0], exterior: true },
  ],
  rooms: [{ id: 'living', name: 'Living', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], floor: 'living-floor' }],
  furniture: [
    { id: 'table', type: 'box', fixture: true, position: [3, 2], size: [1, 1, 0.75] },
    { id: 'nordic-cabinet', type: 'box', fixture: true, position: [1, 1], size: [0.8, 0.5, 1.2], designOptions: ['nordic'] },
    { id: 'med-cabinet', type: 'box', fixture: true, position: [5, 3], size: [0.8, 0.5, 1.2], designOptions: ['mediterranean'] },
  ],
  materials: { ...Object.fromEntries(Object.keys(BUILTIN).map((key) => [key, { color: '#ffffff' }])), 'living-floor': { color: '#888888' } },
  designOptions: [
    { id: 'mediterranean', name: 'Mediterranean', materials: { 'living-floor': { color: '#b5651d' } } },
    { id: 'nordic', name: 'Nordic', default: true, materials: { 'living-floor': { color: '#eeeeee' } } },
  ],
});

async function house(plan: Plan) {
  const lib = new MaterialLibrary(plan, () => undefined);
  const built = await buildHouse(plan, lib, { resolveUrl: () => undefined });
  cleanup.push(() => {
    built.dispose();
    lib.dispose();
  });
  built.root.updateMatrixWorld(true);
  return built;
}

/** The floor material the room's merged floor mesh draws with. */
function floorMaterial(built: Awaited<ReturnType<typeof house>>) {
  let found: THREE.MeshStandardMaterial | undefined;
  built.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if ((o as THREE.Mesh).isMesh && m?.name === 'living-floor') found = m;
  });
  return found!;
}

/** Height of the first collider under a plan point, from 2 m up, under the ceiling. */
function standsOn(world: THREE.Group, x: number, z: number) {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 2, z), new THREE.Vector3(0, -1, 0));
  return ray.intersectObjects(world.children, false)[0]?.point.y ?? -Infinity;
}

test('a plan opens on its default design option, with its finishes and furniture only', async () => {
  const built = await house(styled());
  expect(built.designOption).toBe('nordic');
  expect(`#${floorMaterial(built).color.getHexString()}`).toBe('#eeeeee');
  expect(standsOn(built.colliders, 1, 1)).toBeCloseTo(1.2, 2);
  expect(standsOn(built.colliders, 5, 3)).toBeCloseTo(0, 2);
});

test('switching option swaps finishes, furniture and collision in place, and switching back reuses the look', async () => {
  const built = await house(styled());
  const nordicFloor = floorMaterial(built);
  const plan = styled();
  built.setDesignOption(plan.designOptions![0]);
  expect(built.designOption).toBe('mediterranean');
  expect(`#${floorMaterial(built).color.getHexString()}`).toBe('#b5651d');
  expect(standsOn(built.colliders, 1, 1)).toBeCloseTo(0, 2);
  expect(standsOn(built.colliders, 5, 3)).toBeCloseTo(1.2, 2);
  // Shared furniture stays in every look.
  expect(standsOn(built.collidersFixed, 3, 2)).toBeCloseTo(0.75, 2);
  built.setDesignOption(plan.designOptions![1]);
  expect(floorMaterial(built)).toBe(nordicFloor);
});

test('the validator checks design options and the furniture that names them', () => {
  expect(validatePlan(styled()).filter((issue) => issue.level === 'error')).toEqual([]);
  const unknown = styled();
  unknown.furniture![1].designOptions = ['scandi'];
  expect(validatePlan(unknown).some((issue) => issue.where === 'furniture nordic-cabinet' && issue.message.includes('"scandi" does not exist'))).toBe(true);
  const twoDefaults = styled();
  twoDefaults.designOptions![0].default = true;
  expect(validatePlan(twoDefaults).some((issue) => issue.message === 'only one design option can be the default')).toBe(true);
  const colourless = styled();
  colourless.designOptions![0].materials = { 'living-floor': {} as never };
  expect(validatePlan(colourless).some((issue) => issue.where === 'design option mediterranean' && issue.level === 'error')).toBe(true);
});
