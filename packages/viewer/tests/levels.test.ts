import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import type { Capsule } from 'three/examples/jsm/math/Capsule.js';
import { buildHouse, CUT_HEIGHT, NO_CUT, SLAB } from '../src/build/house.ts';
import { MaterialLibrary } from '../src/build/materials.ts';
import { cameraView, levelAt, levelPlan, stairFlights } from '../src/plan/levels.ts';
import type { Plan } from '../src/plan/schema.ts';
import { validatePlan } from '../src/plan/validate.ts';
import { Walker } from '../src/viewer/walk.ts';
import { twoStorey } from './two-storey.ts';

const originals = new Map<string, PropertyDescriptor | undefined>();
const cleanup: (() => void)[] = [];

beforeEach(() => {
  for (const name of ['document', 'window']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
  }
});

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

function key(code: string, down = true) {
  const event = new Event(down ? 'keydown' : 'keyup', { cancelable: true });
  Object.assign(event, { code, repeat: false });
  document.dispatchEvent(event);
}

async function house(plan: Plan = twoStorey) {
  const lib = new MaterialLibrary(plan, () => undefined);
  const built = await buildHouse(plan, lib, { resolveUrl: () => undefined });
  cleanup.push(() => {
    built.dispose();
    lib.dispose();
  });
  return built;
}

const errors = (plan: Plan) => validatePlan(plan).filter((issue) => issue.level === 'error');
const clone = (): Plan => structuredClone(twoStorey);

test('the two-storey fixture validates without errors or stair warnings', () => {
  expect(errors(twoStorey)).toEqual([]);
  expect(validatePlan(twoStorey).filter((issue) => issue.where === 'furniture flight')).toEqual([]);
});

test('unknown levels, cramped storeys and stairs that land nowhere are reported', () => {
  const plan = clone();
  plan.rooms![0].level = 'attic';
  expect(errors(plan).map((issue) => issue.where)).toContain('room living');

  const cramped = clone();
  cramped.levels![1].elevation = 1.5;
  expect(errors(cramped).some((issue) => issue.where === 'level upper')).toBe(true);

  const short = clone();
  short.furniture![0].size = [1.1, 3.8, 2.2];
  expect(validatePlan(short).some((issue) => issue.where === 'furniture flight' && issue.level === 'warn')).toBe(true);

  const orphan = clone();
  orphan.levels = undefined;
  expect(errors(orphan).some((issue) => issue.message.includes('does not exist'))).toBe(true);
});

test('each storey is its own plan, measured from its floor', () => {
  const [ground, upper] = twoStorey.levels!;
  const top = levelPlan(twoStorey, upper);
  expect(top.walls.every((w) => w.level === 'upper')).toBe(true);
  expect(top.rooms!.map((r) => r.id)).toEqual(['bedroom', 'landing']);
  expect(top.openings!.map((o) => o.id)).toEqual(['bedroom-door', 'bedroom-window']);
  expect(top.defaults!.wallHeight).toBe(2.6);
  expect(levelPlan(twoStorey, ground).defaults!.wallHeight).toBe(2.8);
  expect(levelAt(twoStorey, 0).id).toBe('ground');
  expect(levelAt(twoStorey, 2.5).id).toBe('upper');
  expect(cameraView(twoStorey, twoStorey.cameras![1]).position[1]).toBeCloseTo(4.4, 6);
  const [flight] = stairFlights(twoStorey);
  expect(flight.top).toBeCloseTo(2.8, 6);
  expect(Math.min(...flight.footprint.map((p) => p[1]))).toBeCloseTo(1.4, 6);
});

test('a single-storey plan keeps one storey cut at 1.2 m with nothing above', async () => {
  const plan = clone();
  plan.levels = undefined;
  plan.walls = plan.walls.filter((w) => w.level === 'ground').map(({ level: _, ...w }) => w);
  plan.rooms = plan.rooms!.filter((r) => r.level === 'ground').map(({ level: _, ...r }) => r);
  plan.furniture = plan.furniture!.filter((f) => f.type !== 'stairs' && f.level === 'ground').map(({ level: _, ...f }) => f);
  plan.cameras = plan.cameras!.filter((c) => c.level === 'ground').map(({ level: _, ...c }) => c);
  plan.openings = plan.openings!.filter((o) => o.wall.startsWith('ground'));
  const built = await house(plan);
  expect(built.levels.map((l) => [l.cut, l.top])).toEqual([[CUT_HEIGHT, NO_CUT]]);
  expect(built.rooms.every((r) => r.center.y === 0)).toBe(true);
});

test('upper rooms, walls and furniture are lifted onto their floor', async () => {
  const built = await house();
  expect(built.levels.map((l) => l.level.id)).toEqual(['ground', 'upper']);
  expect(built.levels[0].top).toBeCloseTo(2.8 - SLAB - 0.01, 6);
  expect(built.levels[1].cut).toBeCloseTo(2.8 + CUT_HEIGHT, 6);
  expect(built.rooms.find((r) => r.room.id === 'bedroom')!.center.y).toBe(2.8);
  // Pick boxes keep each piece's bounds after the meshes are merged; they pad by 3 cm.
  expect(built.parts.find((p) => p.id === 'bed')!.box.min.y).toBeCloseTo(2.77, 2);
});

for (const hz of [60, 120]) {
  test(`the flight climbs from the hall to the landing and back down at ${hz}Hz`, async () => {
    const built = await house();
    const walker = new Walker(new EventTarget() as HTMLElement, 1);
    cleanup.push(() => walker.dispose());
    walker.setWorld(built.collidersFixed);
    // At the foot of the flight, facing up it (north, toward −y in plan).
    walker.place(7.15, 5.55, 7.15, 0);
    walker.active = true;
    const body = (walker as unknown as { capsule: Capsule }).capsule;
    const feet = () => body.start.y - body.radius;
    const run = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds * hz); i++) walker.update(1 / hz);
    };
    run(0.3);
    expect(feet()).toBeCloseTo(0, 2);

    key('KeyW');
    let highest = 0;
    for (let i = 0; i < 5 * hz; i++) {
      walker.update(1 / hz);
      highest = Math.max(highest, feet());
    }
    key('KeyW', false);
    run(0.3);
    expect(feet()).toBeCloseTo(2.8, 2);
    expect(highest).toBeLessThan(2.85);
    // On the landing, past the top tread and short of the north wall.
    expect(walker.position.z).toBeLessThan(1.4);
    expect(walker.position.z).toBeGreaterThan(0.15);

    key('KeyS');
    run(5);
    key('KeyS', false);
    run(0.3);
    expect(feet()).toBeCloseTo(0, 2);
    expect(walker.position.z).toBeGreaterThan(5.2);
  });
}

test('the guard around the opening keeps a walker on the landing from stepping into the stairwell', async () => {
  const built = await house();
  const walker = new Walker(new EventTarget() as HTMLElement, 1);
  cleanup.push(() => walker.dispose());
  walker.setWorld(built.collidersFixed);
  // Beside the opening on the landing, walking straight at it.
  walker.place(5.9, 3.3, 9, 3.3, 2.8);
  walker.active = true;
  key('KeyW');
  for (let i = 0; i < 3 * 120; i++) walker.update(1 / 120);
  key('KeyW', false);
  expect(walker.position.y).toBeCloseTo(2.8, 2);
  expect(walker.position.x).toBeLessThan(6.6 - 0.2);
});

test('a stair with a half landing validates and opens the ceiling over its upper run', async () => {
  const plan = clone();
  // Two runs of 1.4 m joined by a landing platform at the north end of the hall.
  plan.furniture = [
    { id: 'lower-run', type: 'stairs', level: 'ground', room: 'hall', position: [7.25, 4.3], size: [0.9, 1.8, 1.4] },
    { id: 'half-landing', type: 'box', fixture: true, level: 'ground', room: 'hall', position: [6.7, 2.7], size: [2, 1.4, 1.4] },
    { id: 'upper-run', type: 'stairs', level: 'ground', room: 'hall', position: [6.15, 4.3], size: [0.9, 1.8, 1.4], rotation: 180, elevation: 1.4 },
  ];
  expect(validatePlan(plan).filter((issue) => issue.where.startsWith('furniture'))).toEqual([]);
  const built = await house(plan);
  const ray = new THREE.Raycaster(new THREE.Vector3(6.15, 2.5, 4.3), new THREE.Vector3(0, 1, 0), 0, 0.4);
  // Straight up from beside the upper run: the hall ceiling at 2.59 m is open above it.
  expect(ray.intersectObjects(built.collidersFixed.children, false)).toEqual([]);
});

test('the landing floor and the hall ceiling are open over the flight only', async () => {
  const built = await house();
  built.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const hit = (x: number, z: number, from: number) => {
    ray.set(new THREE.Vector3(x, from, z), down);
    ray.far = from - 2.7;
    return ray.intersectObjects(built.collidersFixed.children, false).length > 0;
  };
  // Straight down from just under the upper ceiling: the landing floor is open over the flight.
  expect(hit(7.15, 3.4, 5)).toBe(false);
  expect(hit(5.8, 3.4, 5)).toBe(true);
  expect(hit(2.5, 1, 5)).toBe(true);
});

test('the stair guard leaves out a side that lies along a wall', async () => {
  const { stairGuard } = await import('../src/build/house.ts');
  const lib = new MaterialLibrary(twoStorey, () => undefined);
  cleanup.push(() => lib.dispose());
  const upper = levelPlan(twoStorey, twoStorey.levels![1]);
  const free = stairFlights(twoStorey)[0].footprint;
  // Panel and handrail per guarded side.
  expect(stairGuard(free, lib, upper).children.length).toBe(6);
  // The same flight pushed against the east wall's inside face at x 7.85.
  const against = free.map(([x, y]): [number, number] => [x + 0.15, y]);
  expect(stairGuard(against, lib, upper).children.length).toBe(4);
});

test('no downlight hangs over a flight of stairs', async () => {
  const { buildDressing } = await import('../src/build/dressing.ts');
  const ground = levelPlan(twoStorey, twoStorey.levels![0]);
  const lib = new MaterialLibrary(ground, () => undefined);
  cleanup.push(() => lib.dispose());
  const [flight] = stairFlights(twoStorey);
  const xs = flight.footprint.map((p) => p[0]), zs = flight.footprint.map((p) => p[1]);
  const lights = buildDressing(ground, lib, (key) => lib.get(key)).children.filter((o) => o.userData.ceiling);
  expect(lights.length).toBeGreaterThan(0);
  for (const light of lights) {
    const over = light.position.x > Math.min(...xs) - 0.3 && light.position.x < Math.max(...xs) + 0.3 && light.position.z > Math.min(...zs) - 0.3 && light.position.z < Math.max(...zs) + 0.3;
    expect(over).toBe(false);
  }
});
