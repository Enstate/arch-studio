import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import type { Capsule } from 'three/examples/jsm/math/Capsule.js';
import { buildHouse } from '../src/build/house.ts';
import { BUILTIN, MaterialLibrary } from '../src/build/materials.ts';
import type { Plan } from '../src/plan/schema.ts';
import { Walker } from '../src/viewer/walk.ts';

const originals = new Map<string, PropertyDescriptor | undefined>();
const walkers: Walker[] = [];
const worlds: THREE.Group[] = [];

beforeEach(() => {
  for (const name of ['document', 'window']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
  }
});

afterEach(() => {
  for (const walker of walkers.splice(0)) walker.dispose();
  for (const world of worlds.splice(0)) {
    world.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
  }
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

function box(x0: number, x1: number, y0: number, y1: number, z0 = -2, z1 = 2) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0));
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return mesh;
}

function world(...meshes: THREE.Mesh[]) {
  const group = new THREE.Group();
  if (meshes.length) group.add(...meshes);
  worlds.push(group);
  return group;
}

function key(code: string, down = true, repeat = false, target: boolean | string = false) {
  const event = new Event(down ? 'keydown' : 'keyup', { cancelable: true });
  Object.assign(event, { code, repeat });
  if (target) Object.defineProperty(event, 'target', { value: {
    closest: (selector: string) => selector.split(',').some(part => part.trim() === (target === true ? 'input' : target)) ? {} : null,
  } });
  document.dispatchEvent(event);
  return event;
}

function fixture(geometry = world(box(-10, 10, -0.2, 0)), x = -0.26, z = 0, heading = 0) {
  const walker = new Walker(new EventTarget() as HTMLElement, 1);
  walkers.push(walker);
  walker.setWorld(geometry);
  walker.place(x, z, x + Math.cos(heading), z + Math.sin(heading));
  walker.active = true;
  // Inspect the real body and independently check its intersections. No physics is mocked.
  const body = (walker as unknown as { capsule: Capsule }).capsule;
  const octree = new Octree().fromGraphNode(geometry);
  const feet = () => body.start.y - body.radius;
  const grounded = () => (walker as unknown as { onFloor: boolean }).onFloor;
  const frame = (dt: number) => {
    walker.update(dt);
    for (const value of [...body.start.toArray(), ...body.end.toArray(), ...walker.camera.position.toArray()]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    const collision = octree.capsuleIntersect(body);
    expect(collision ? collision.depth : 0).toBeLessThan(0.002);
    expect(Math.abs(body.start.z)).toBeLessThan(10);
    expect(Math.abs(body.start.x)).toBeLessThan(10);
  };
  const advance = (seconds: number, hz = 60, inspect?: () => void) => {
    for (let i = 0; i < Math.round(seconds * hz); i++) {
      frame(1 / hz);
      inspect?.();
    }
  };
  advance(0.2);
  return { walker, body, feet, grounded, frame, advance };
}

for (const hz of [60, 120]) {
  test(`pressing a 2m wall keeps floor contact and allows Space at ${hz}Hz`, () => {
    const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 0.2, 0, 2)));
    key('KeyW');
    f.advance(0.5, hz);
    f.advance(0.2, hz, () => {
      expect(f.grounded()).toBe(true);
      expect(f.walker.position.x).toBeLessThanOrEqual(-0.249);
    });
    key('Space');
    f.advance(0.1, hz, () => { expect(f.walker.position.x).toBeLessThanOrEqual(-0.249); });
    expect(f.feet()).toBeGreaterThan(0.3);
    f.advance(0.7, hz);
    expect(f.grounded()).toBe(true);
    expect(f.feet()).toBeCloseTo(0.001, 2);
  });

  test(`pressing a closed door keeps floor contact and allows Space at ${hz}Hz`, () => {
    const f = fixture();
    const door = new THREE.Box3(new THREE.Vector3(0, 0, -2), new THREE.Vector3(0.1, 2.5, 2));
    f.walker.blockers = () => [door];
    key('KeyW');
    f.advance(0.5, hz);
    f.advance(0.2, hz, () => {
      expect(f.grounded()).toBe(true);
      expect(f.walker.position.x).toBeLessThanOrEqual(-0.249);
    });
    key('Space');
    f.advance(0.1, hz, () => { expect(f.walker.position.x).toBeLessThanOrEqual(-0.249); });
    expect(f.feet()).toBeGreaterThan(0.3);
    f.advance(0.7, hz);
    expect(f.grounded()).toBe(true);
    expect(f.feet()).toBeCloseTo(0.001, 2);
  });
}

for (const degrees of [45, 60]) {
  for (const hz of [60, 120]) {
    test(`a 0.30m ledge climbs from rest at a ${degrees} degree approach at ${hz}Hz`, () => {
      const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.3)), -0.26, -0.5, degrees * Math.PI / 180);
      key('KeyW');
      f.advance(1, hz, () => {
        expect(f.grounded()).toBe(true);
        expect(f.feet()).toBeGreaterThanOrEqual(-0.002);
        expect(f.feet()).toBeLessThan(0.302);
      });
      expect(f.walker.position.x).toBeGreaterThan(0.3);
      expect(f.feet()).toBeCloseTo(0.301, 3);
    });
  }
}

for (const degrees of [20, 30]) {
  test(`a 0.30m ledge climbs at a ${degrees} degree approach at 120Hz`, () => {
    const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.3)), -0.26, -0.5, degrees * Math.PI / 180);
    key('KeyW');
    f.advance(1, 120);
    expect(f.walker.position.x).toBeGreaterThan(0.7);
    expect(f.feet()).toBeCloseTo(0.301, 3);
  });
}

test('0.18m stairs climb while sliding against a side wall at 120Hz', () => {
  const stairs = Array.from({ length: 5 }, (_, i) => box(i * 0.3, i === 4 ? 5 : (i + 1) * 0.3, 0, (i + 1) * 0.18));
  const f = fixture(world(box(-10, 10, -0.2, 0), ...stairs, box(-2, 6, 0, 3, 0.25, 0.5)), -0.26, -0.001, Math.PI / 6);
  key('KeyW');
  f.advance(1.8, 120, () => {
    expect(f.grounded()).toBe(true);
    expect(f.walker.position.z).toBeLessThanOrEqual(0.001);
    expect(f.feet()).toBeLessThan(0.902);
  });
  expect(f.walker.position.x).toBeGreaterThan(1.8);
  expect(f.feet()).toBeCloseTo(0.901, 3);
});

for (const barrier of ['wall', 'door']) {
  test(`sliding along a tall ${barrier} stays grounded and solid during a jump at 120Hz`, () => {
    const geometry = world(box(-10, 10, -0.2, 0));
    if (barrier === 'wall') geometry.add(box(0, 0.1, 0, 2.5));
    const f = fixture(geometry, -0.26, -0.5, Math.PI / 6);
    if (barrier === 'door') {
      const door = new THREE.Box3(new THREE.Vector3(0, 0, -2), new THREE.Vector3(0.1, 2.5, 2));
      f.walker.blockers = () => [door];
    }
    key('KeyW');
    f.advance(0.5, 120, () => {
      expect(f.grounded()).toBe(true);
      expect(f.walker.position.x).toBeLessThanOrEqual(-0.249);
    });
    key('Space');
    let peak = f.feet();
    f.advance(0.8, 120, () => {
      expect(f.walker.position.x).toBeLessThanOrEqual(-0.249);
      peak = Math.max(peak, f.feet());
    });
    expect(peak).toBeGreaterThan(0.45);
    expect(f.walker.position.z).toBeGreaterThan(-0.1);
    expect(f.grounded()).toBe(true);
  });
}

test('a thin overhead beam rejects a step without clipping the head', () => {
  const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.3), box(-2, 4, 1.85, 1.86, -0.02, 0.02)));
  key('KeyW');
  f.advance(0.8, 120, () => {
    expect(f.body.end.y + f.body.radius).toBeLessThan(1.851);
    expect(f.feet()).toBeLessThan(0.01);
  });
  expect(f.walker.position.x).toBeLessThanOrEqual(-0.249);
});

test('Space jumps from rest, lands, and cannot jump again while held', () => {
  const f = fixture();
  const base = f.feet();
  expect(key('Space').defaultPrevented).toBe(true);
  expect(f.walker.jump()).toBe(false);
  let peak = base;
  f.advance(0.8, 60, () => { peak = Math.max(peak, f.feet()); });
  expect(peak - base).toBeGreaterThan(0.45);
  expect(peak - base).toBeLessThan(0.52);
  expect(f.feet()).toBeCloseTo(base, 2);
  key('Space', true, true);
  key('Space');
  f.advance(0.2);
  expect(f.feet()).toBeCloseTo(base, 2);
  expect(key('Space', false).defaultPrevented).toBe(true);
  key('Space');
  f.advance(0.1);
  expect(f.feet()).toBeGreaterThan(base + 0.3);
});

test('inactive and text-targeted Space do not jump or prevent default', () => {
  const f = fixture();
  expect(key('Space', true, false, true).defaultPrevented).toBe(false);
  f.advance(0.1);
  expect(f.feet()).toBeCloseTo(0.001, 2);
  f.walker.active = false;
  expect(key('Space').defaultPrevented).toBe(false);
  expect(f.walker.jump()).toBe(false);
  f.walker.active = true;
  expect(key('Space', true, true).defaultPrevented).toBe(true);
  f.advance(0.1);
  expect(f.feet()).toBeCloseTo(0.001, 2);
});

test.each(['button', 'a', '[role=button]'])('a focused %s keeps Space activation without blocking walking', target => {
  const f = fixture();
  expect(key('Space', true, false, target).defaultPrevented).toBe(false);
  expect(key('Space', false, false, target).defaultPrevented).toBe(false);
  key('KeyW', true, false, target);
  f.advance(0.2);
  expect(f.feet()).toBeCloseTo(0.001, 2);
  expect(f.walker.position.x).toBeGreaterThan(-0.12);
  key('KeyW', false, false, target);
  f.advance(0.8);
  const stoppedX = f.walker.position.x;

  key('KeyW');
  key('KeyW', false, false, target);
  key('Space');
  expect(key('Space', false, false, target).defaultPrevented).toBe(false);
  f.advance(0.8);
  expect(f.walker.position.x).toBeCloseTo(stoppedX, 3);
  expect(key('Space').defaultPrevented).toBe(true);
  f.advance(0.1);
  expect(f.feet()).toBeGreaterThan(0.3);
});

test('keyup clears held movement and Space even when focus or walk mode changes', () => {
  const f = fixture();
  key('KeyW');
  f.walker.active = false;
  key('KeyW', false, false, true);
  f.walker.active = true;
  f.advance(0.2);
  expect(f.walker.position.x).toBeCloseTo(-0.26, 4);
  key('Space');
  key('Space', false, false, true);
  f.advance(0.8);
  expect(f.walker.jump()).toBe(true);
});

test('a wall contact cannot lift the walker past a later step without touching it', () => {
  const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 0.2, 0, 2, -2, 0.4), box(0, 1, 0, 0.3, 1.6, 2.6)));
  key('KeyW');
  f.advance(0.2);
  key('KeyW', false);
  key('KeyD');
  f.advance(2, 60, () => { expect(f.feet()).toBeLessThan(0.02); });
  expect(f.walker.position.z).toBeGreaterThan(2);
});

test('a 0.30m ledge climbs at walking speed from a standstill beside the edge', () => {
  const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.3)));
  key('KeyW');
  let firstStepCamera = 0;
  f.advance(0.8, 60, () => {
    expect(f.feet()).toBeGreaterThanOrEqual(-0.002);
    expect(f.feet()).toBeLessThan(0.302);
    if (!firstStepCamera && f.feet() > 0.29) firstStepCamera = f.walker.camera.position.y;
  });
  expect(f.walker.position.x).toBeGreaterThan(0.7);
  expect(f.feet()).toBeCloseTo(0.301, 3);
  expect(firstStepCamera).toBeGreaterThan(1.6);
  expect(firstStepCamera).toBeLessThan(1.85);
  expect(f.walker.camera.position.y).toBeCloseTo(f.body.end.y + 0.1, 2);
  key('KeyW', false);
  f.advance(0.8);
  expect(f.feet()).toBeCloseTo(0.301, 3);
});

test('a 0.35m step is climbable and a 0.36m step stays solid', () => {
  const low = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.35)));
  key('KeyW');
  low.advance(0.8);
  expect(low.walker.position.x).toBeGreaterThan(0.5);
  expect(low.feet()).toBeCloseTo(0.351, 3);
  low.walker.active = false;
  const high = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.36)));
  key('KeyW');
  high.advance(0.8);
  expect(high.walker.position.x).toBeLessThanOrEqual(-0.249);
  expect(high.feet()).toBeLessThan(0.01);
});

test('repeated 0.18m stairs climb without a run-up or accumulating height', () => {
  const stairs = Array.from({ length: 5 }, (_, i) => box(i * 0.3, i === 4 ? 5 : (i + 1) * 0.3, 0, (i + 1) * 0.18));
  const f = fixture(world(box(-10, 10, -0.2, 0), ...stairs));
  key('KeyW');
  f.advance(1.5, 60, () => {
    expect(f.feet()).toBeGreaterThanOrEqual(-0.002);
    expect(f.feet()).toBeLessThan(0.902);
  });
  expect(f.walker.position.x).toBeGreaterThan(1.8);
  expect(f.feet()).toBeCloseTo(0.901, 3);
  key('KeyW', false);
  f.advance(0.8);
  expect(f.feet()).toBeCloseTo(0.901, 3);
});

test('a 0.5m wall stays solid at walking and running speeds', () => {
  const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.5)));
  key('KeyW');
  f.advance(0.6);
  key('ShiftLeft');
  f.advance(0.6);
  expect(f.walker.position.x).toBeLessThanOrEqual(-0.249);
  expect(f.feet()).toBeLessThan(0.01);
});

test('a low ceiling rejects the step without lifting or clipping the head', () => {
  const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.3), box(-2, 4, 1.85, 1.9)));
  key('KeyW');
  f.advance(0.8, 60, () => {
    expect(f.body.end.y + f.body.radius).toBeLessThan(1.851);
    expect(f.feet()).toBeLessThan(0.01);
  });
  expect(f.walker.position.x).toBeLessThanOrEqual(-0.249);
});

test('a jump hits the ceiling and returns to the floor', () => {
  const f = fixture(world(box(-10, 10, -0.2, 0), box(-2, 4, 2, 2.05)));
  expect(f.walker.jump()).toBe(true);
  f.advance(0.6, 60, () => { expect(f.body.end.y + f.body.radius).toBeLessThan(2.002); });
  expect(f.feet()).toBeCloseTo(0.001, 2);
});

for (const fixed of [false, true]) {
  test(`built room ceiling stops a platform jump with ${fixed ? 'fixed' : 'all'} colliders`, async () => {
    const plan: Plan = {
      version: 1, name: 'Low ceiling regression', defaults: { wallHeight: 2.6 },
      walls: [
        { id: 'north', a: [0, 0], b: [4, 0], exterior: true },
        { id: 'east', a: [4, 0], b: [4, 4], exterior: true },
        { id: 'south', a: [4, 4], b: [0, 4], exterior: true },
        { id: 'west', a: [0, 4], b: [0, 0], exterior: true },
      ],
      rooms: [{ id: 'room', name: 'Room', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], ceilingHeight: 2.4 }],
      furniture: [{ id: 'platform', type: 'box', fixture: true, position: [2, 2], size: [2, 2, 0.35] }],
      materials: Object.fromEntries(Object.keys(BUILTIN).map(key => [key, { color: '#ffffff' }])),
    };
    const lib = new MaterialLibrary(plan, () => undefined);
    const house = await buildHouse(plan, lib, { resolveUrl: () => undefined });
    try {
      const colliders = fixed ? house.collidersFixed : house.colliders;
      const f = fixture(colliders, 2, 2);
      expect(f.feet()).toBeCloseTo(0.351, 3);
      expect(f.walker.jump()).toBe(true);
      let peak = f.feet();
      f.advance(0.8, 120, () => {
        peak = Math.max(peak, f.feet());
        // The real rendered ceiling is 1 cm below the authored height.
        expect(f.body.end.y + f.body.radius).toBeLessThanOrEqual(2.39001);
        expect(f.walker.camera.position.y).toBeLessThan(2.39);
      });
      expect(peak).toBeGreaterThan(0.6);
      expect(f.feet()).toBeCloseTo(0.351, 3);
      expect(f.grounded()).toBe(true);
      // Its underside must not become upward-facing support for a step.
      const octree = new Octree().fromGraphNode(colliders);
      const support = octree.rayIntersect(new THREE.Ray(new THREE.Vector3(2, 2.5, 2), new THREE.Vector3(0, -1, 0)));
      expect(support).toBeTruthy();
      if (support) expect(support.position.y).toBeCloseTo(0.35, 3);
    } finally {
      house.dispose();
      lib.dispose();
    }
  });
}

test('the built roof stops a jump over the exterior courtyard of an L-shaped house', async () => {
  const plan: Plan = {
    version: 1, name: 'Roof collision regression', defaults: { wallHeight: 2.6 },
    walls: [
      { id: 'north', a: [0, 0], b: [4, 0], exterior: true },
      { id: 'east', a: [4, 0], b: [4, 2], exterior: true },
      { id: 'courtyard-north', a: [4, 2], b: [2, 2], exterior: true },
      { id: 'courtyard-west', a: [2, 2], b: [2, 4], exterior: true },
      { id: 'south', a: [2, 4], b: [0, 4], exterior: true },
      { id: 'west', a: [0, 4], b: [0, 0], exterior: true },
    ],
    rooms: [{ id: 'room', name: 'Room', polygon: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]], ceilingHeight: 2.4 }],
    furniture: [{ id: 'platform', type: 'box', fixture: true, position: [3, 3], size: [1, 1, 0.6] }],
    materials: Object.fromEntries(Object.keys(BUILTIN).map(key => [key, { color: '#ffffff' }])),
  };
  const lib = new MaterialLibrary(plan, () => undefined);
  const house = await buildHouse(plan, lib, { resolveUrl: () => undefined });
  try {
    const f = fixture(house.collidersFixed, 3, 3);
    expect(f.feet()).toBeCloseTo(0.601, 3);
    expect(f.walker.jump()).toBe(true);
    let peak = f.feet();
    f.advance(0.8, 120, () => {
      peak = Math.max(peak, f.feet());
      expect(f.body.end.y + f.body.radius).toBeLessThanOrEqual(2.59501);
      expect(f.walker.camera.position.y).toBeLessThan(2.595);
    });
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThan(1);
    expect(f.feet()).toBeCloseTo(0.601, 3);
    expect(f.grounded()).toBe(true);
  } finally {
    house.dispose();
    lib.dispose();
  }
});

test('a closed door blocks a ledge approach and opening it allows the step', () => {
  const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 4, 0, 0.3)));
  const doors = [new THREE.Box3(new THREE.Vector3(-0.01, 0, -1), new THREE.Vector3(0.06, 2.5, 1))];
  f.walker.blockers = () => doors;
  key('KeyW');
  f.advance(0.8, 60, () => {
    expect(f.walker.position.x).toBeLessThanOrEqual(-0.259);
    expect(f.feet()).toBeLessThan(0.01);
  });
  doors.length = 0;
  f.advance(0.8);
  expect(f.walker.position.x).toBeGreaterThan(0.5);
  expect(f.feet()).toBeCloseTo(0.301, 3);
});

test('a door closing on an idle walker still pushes the body clear', () => {
  const f = fixture(undefined, 0);
  f.advance(0.5);
  const door = new THREE.Box3(new THREE.Vector3(-0.1, 0, -1), new THREE.Vector3(0.1, 2.5, 1));
  f.walker.blockers = () => [door];
  f.frame(1 / 60);
  expect(Math.abs(f.walker.position.x)).toBeGreaterThanOrEqual(0.35 - 0.00001);
  const x = f.walker.position.x;
  f.advance(0.5);
  expect(f.walker.position.x).toBeCloseTo(x, 4);
  expect(f.feet()).toBeCloseTo(0.001, 2);
});

test('small downward steps stay grounded and a cliff falls naturally', () => {
  const f = fixture(world(box(-10, 0, -0.5, 0), box(0, 1.5, -0.5, -0.2)), -0.5);
  key('KeyW');
  f.advance(0.8);
  expect(f.feet()).toBeCloseTo(-0.199, 3);
  let lowest = f.feet();
  f.advance(0.8, 60, () => { lowest = Math.min(lowest, f.feet()); });
  expect(lowest).toBeLessThan(-0.5);
});

test('walking off a cliff cannot step upward onto a nearby airborne ledge', () => {
  const f = fixture(world(box(-10, 0, -0.5, 0), box(0.7, 4, -0.5, 0.3)), -0.5);
  key('KeyW');
  let highest = f.feet();
  f.advance(0.8, 60, () => { highest = Math.max(highest, f.feet()); });
  expect(highest).toBeLessThan(0.01);
  expect(f.walker.position.x).toBeLessThan(0.7);
});

test('place snaps the camera and clears grounded jump state; setWorld invalidates old support', () => {
  const f = fixture();
  expect(f.walker.jump()).toBe(true);
  f.advance(0.1);
  f.walker.place(-1, 0, 1, 0);
  expect(f.walker.camera.position.x).toBe(-1);
  expect(f.walker.camera.position.y).toBe(1.6);
  expect(f.walker.jump()).toBe(false);
  f.advance(0.2);
  expect(f.walker.jump()).toBe(true);
  f.walker.setWorld(world());
  expect(f.walker.jump()).toBe(false);
  f.walker.update(0.05);
  expect(f.feet()).toBeLessThan(0.001);
});

test('30Hz and 120Hz give similar walking, stair climbing, and jump heights', () => {
  function traverse(hz: number) {
    const f = fixture(world(box(-10, 10, -0.2, 0), box(0, 0.6, 0, 0.3), box(0.6, 1.2, 0, 0.48), box(1.2, 5, 0, 0.66)));
    key('KeyW');
    f.advance(1.4, hz);
    key('KeyW', false);
    f.advance(0.8, hz);
    const x = f.walker.position.x, floor = f.feet();
    expect(f.walker.jump()).toBe(true);
    let peak = floor;
    f.advance(0.8, hz, () => { peak = Math.max(peak, f.feet()); });
    expect(f.feet()).toBeCloseTo(floor, 2);
    f.walker.active = false;
    return { x, floor, jump: peak - floor };
  }
  const slow = traverse(30), fast = traverse(120);
  expect(slow.x).toBeGreaterThan(1.8);
  expect(fast.x).toBeGreaterThan(1.8);
  expect(Math.abs(slow.x - fast.x)).toBeLessThan(0.05);
  expect(Math.abs(slow.floor - fast.floor)).toBeLessThan(0.002);
  expect(Math.abs(slow.jump - fast.jump)).toBeLessThan(0.02);
});
