import { afterEach, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { buildHouse } from '../src/build/house.ts';
import { buildDressing } from '../src/build/dressing.ts';
import { BUILTIN, MaterialLibrary } from '../src/build/materials.ts';
import { ceilingAt } from '../src/plan/geom.ts';
import type { Plan } from '../src/plan/schema.ts';
import { validatePlan } from '../src/plan/validate.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** A 6 × 4 m room whose ceiling is 2.4 m on the left and rises 12% toward the right. */
const sloped = (): Plan => ({
  version: 1,
  name: 'Sloped ceiling test',
  defaults: { wallHeight: 3.2 },
  walls: [
    { id: 'n', a: [0, 0], b: [6, 0], exterior: true },
    { id: 'e', a: [6, 0], b: [6, 4], exterior: true },
    { id: 's', a: [6, 4], b: [0, 4], exterior: true },
    { id: 'w', a: [0, 4], b: [0, 0], exterior: true },
  ],
  rooms: [{ id: 'studio', name: 'Studio', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], ceilingHeight: 2.4, ceilingSlope: { rise: 0.12, toward: 90 }, lightK: 3000 }],
  materials: Object.fromEntries(Object.keys(BUILTIN).map((key) => [key, { color: '#ffffff' }])),
});

async function house(plan: Plan) {
  const lib = new MaterialLibrary(plan, () => undefined);
  const built = await buildHouse(plan, lib, { resolveUrl: () => undefined });
  cleanup.push(() => {
    built.dispose();
    lib.dispose();
  });
  built.root.updateMatrixWorld(true);
  return { built, lib };
}

/** Height of the first collider straight above a plan point. */
function above(group: THREE.Object3D, x: number, z: number) {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 1, z), new THREE.Vector3(0, 1, 0));
  return ray.intersectObjects(group.children, false)[0]?.point.y ?? Infinity;
}

test('a sloped ceiling rises from its low side, or from the point it names', () => {
  const plan = sloped();
  const room = plan.rooms![0];
  expect(ceilingAt(plan, room, [0, 2])).toBeCloseTo(2.4, 6);
  expect(ceilingAt(plan, room, [5, 2])).toBeCloseTo(3.0, 6);
  // Toward 0 rises toward the top of the plan (−y): the bottom edge is low.
  expect(ceilingAt(plan, { ...room, ceilingSlope: { rise: 0.1, toward: 0 } }, [3, 0])).toBeCloseTo(2.8, 6);
  expect(ceilingAt(plan, { ...room, ceilingSlope: { rise: 0.12, toward: 90, from: [3, 0] } }, [0, 0])).toBeCloseTo(2.04, 6);
  expect(ceilingAt(plan, { ...room, ceilingSlope: undefined }, [5, 2])).toBe(2.4);
});

test('the walk-mode ceiling and the room lamp follow the slope', async () => {
  const plan = sloped();
  const { built } = await house(plan);
  expect(above(built.collidersFixed, 1, 2)).toBeCloseTo(ceilingAt(plan, plan.rooms![0], [1, 2]) - 0.01, 2);
  expect(above(built.collidersFixed, 5, 2)).toBeCloseTo(ceilingAt(plan, plan.rooms![0], [5, 2]) - 0.01, 2);
  const lamp = built.lights.children.find((o) => (o as THREE.PointLight).isPointLight)!;
  expect(lamp.position.y).toBeCloseTo(ceilingAt(plan, plan.rooms![0], [3, 2]) - 0.27, 3);
});

test('downlights sit in the sloped ceiling over them, never above it', () => {
  const plan = sloped();
  const lib = new MaterialLibrary(plan, () => undefined);
  cleanup.push(() => lib.dispose());
  const dressing = buildDressing(plan, lib, (key) => lib.get(key));
  const lights = dressing.children.filter((o) => o.type === 'Group');
  expect(lights.length).toBeGreaterThan(2);
  for (const light of lights) {
    const ceiling = ceilingAt(plan, plan.rooms![0], [light.position.x, light.position.z]);
    expect(light.position.y).toBeCloseTo(ceiling - 0.012, 6);
  }
  expect(new Set(lights.map((l) => l.position.y.toFixed(3))).size).toBeGreaterThan(1);
});

test('plan roofs replace the generated slab, never collide, and stay out of the loose furniture', async () => {
  const flat = await house(sloped());
  // Without plan roofs the viewer adds its slab over the walls, at 3.2 m.
  expect(above(flat.built.collidersFixed, 3, 2)).toBeLessThan(3.1);
  expect(flat.built.roofs.children.length).toBe(0);

  const plan = sloped();
  plan.rooms![0].ceilingSlope = undefined;
  plan.rooms![0].ceilingHeight = 3.1;
  plan.furniture = [{ id: 'roof', type: 'box', roof: true, position: [3, 2], size: [7, 5, 0.2], elevation: 3.3 }];
  const { built } = await house(plan);
  expect(built.roofs.children.length).toBeGreaterThan(0);
  expect(built.looseFurniture.children.length).toBe(0);
  // Above the 3.09 m ceiling there is nothing to hit: no generated slab and no roof collider.
  const ray = new THREE.Raycaster(new THREE.Vector3(3, 3.15, 2), new THREE.Vector3(0, 1, 0));
  expect(ray.intersectObjects(built.collidersFixed.children, false)).toEqual([]);
  expect(ray.intersectObjects(built.colliders.children, false)).toEqual([]);
});

test('the validator checks sloped ceilings and roof flags', () => {
  expect(validatePlan(sloped()).filter((issue) => issue.level === 'error')).toEqual([]);
  const low = sloped();
  low.rooms![0].ceilingHeight = 1.5;
  expect(validatePlan(low).some((issue) => issue.where === 'room studio' && issue.message.includes('comes down to 1.50 m'))).toBe(true);
  const broken = sloped();
  broken.rooms![0].ceilingSlope = { rise: -0.1, toward: 90 };
  expect(validatePlan(broken).some((issue) => issue.level === 'error' && issue.where === 'room studio')).toBe(true);
  const roof = sloped();
  roof.furniture = [{ id: 'roof', type: 'box', position: [3, 2], roof: 'yes' as unknown as boolean }];
  expect(validatePlan(roof).some((issue) => issue.level === 'error' && issue.message === 'roof must be a boolean')).toBe(true);
});

test('only the largest rooms keep lamp shadows, so many lamps cannot blank the evening view', async () => {
  const plan = sloped();
  // Nine rooms of growing size along a 30 m strip, each with a ceiling lamp.
  plan.walls = [{ id: 'n', a: [0, 0], b: [45, 0], exterior: true }, { id: 's', a: [45, 4], b: [0, 4], exterior: true }];
  plan.rooms = Array.from({ length: 9 }, (_, i) => {
    const x0 = (i * (i + 1)) / 2, x1 = ((i + 1) * (i + 2)) / 2;
    return { id: `room-${i}`, name: `Room ${i}`, polygon: [[x0, 0], [x1, 0], [x1, 4], [x0, 4]] as [number, number][], lightK: 3000 };
  });
  const lib = new MaterialLibrary(plan, () => undefined);
  const built = await buildHouse(plan, lib, { resolveUrl: () => undefined });
  cleanup.push(() => {
    built.dispose();
    lib.dispose();
  });
  const lamps = built.lights.children.filter((o): o is THREE.PointLight => (o as THREE.PointLight).isPointLight);
  expect(lamps.length).toBe(9);
  expect(lamps.filter((l) => l.castShadow).map((l) => l.userData.room).sort()).toEqual(['room-3', 'room-4', 'room-5', 'room-6', 'room-7', 'room-8']);
});
