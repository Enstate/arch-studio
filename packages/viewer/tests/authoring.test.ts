import { expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import { buildHouse } from '../src/build/house.ts';
import { buildOpenings } from '../src/build/openings.ts';
import { BUILTIN, MaterialLibrary } from '../src/build/materials.ts';
import { validatePlan } from '../src/plan/validate.ts';
import type { Furniture, Plan } from '../src/plan/schema.ts';
import { openingDoors, poseDoor } from '../src/viewer/doors.ts';

// Bun provides fetch but not the progress event used by Three's browser loader.
if (!globalThis.ProgressEvent) {
  globalThis.ProgressEvent = class extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init: ProgressEventInit = {}) {
      super(type);
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  } as typeof ProgressEvent;
}

function plan(): Plan {
  return {
    version: 1, name: 'Authored house', walls: [{ id: 'wall', a: [0, 0], b: [8, 0] }],
    materials: Object.fromEntries(Object.keys(BUILTIN).map(key => [key, { color: '#ffffff' }])),
  };
}

// A self-contained custom GLB, decoded by the same GLTFLoader as project assets.
function modelUrl() {
  const positions = new THREE.BoxGeometry(1, 1, 1).toNonIndexed().attributes.position.array;
  const binary = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }],
  });
  const padded = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const chunk = Buffer.alloc(8);
  chunk.writeUInt32LE(binary.length, 0); chunk.writeUInt32LE(0x004e4942, 4);
  return `data:model/gltf-binary;base64,${Buffer.concat([header, padded, chunk, binary]).toString('base64')}`;
}

test.each([
  ['custom fixture', 'box', true, './models/built-in.glb', false],
  ['loose wardrobe', 'wardrobe', false, undefined, true],
  ['pendant filename', 'box', undefined, './models/pendant.glb', true],
  ['default kitchen', 'kitchen-base', undefined, undefined, false],
] as const)('%s keeps its authored furniture visibility and collider membership', async (_name, type, fixture, model, loose) => {
  const p = plan();
  p.furniture = [{ id: 'piece', type, position: [3, 2], size: [1, 1, 1], fixture, model } as Furniture];
  const lib = new MaterialLibrary(p, () => undefined);
  const errors: string[] = [];
  const manager = new THREE.LoadingManager();
  manager.onError = url => errors.push(url);
  const house = await buildHouse(p, lib, { resolveUrl: () => modelUrl(), manager });
  try {
    expect(errors).toEqual([]);
    expect(house.parts.find(part => part.id === 'piece')?.loose ?? false).toBe(loose);
    // Approach the outward face, as the walker does. The octree rejects triangle back faces.
    const capsule = new Capsule(new THREE.Vector3(3.65, 0.4, 2), new THREE.Vector3(3.65, 0.8, 2), 0.25);
    expect(!!new Octree().fromGraphNode(house.collidersFixed).capsuleIntersect(capsule)).toBe(!loose);
    expect(!!new Octree().fromGraphNode(house.colliders).capsuleIntersect(capsule)).toBe(true);
    if (model) {
      expect(house.parts.find(part => part.id === 'piece')?.box.getSize(new THREE.Vector3()).x).toBeCloseTo(1.06);
    }
  } finally { house.dispose(); lib.dispose(); }
});

test.each(['false', null, 0, {}])('plan validation rejects nonboolean fixture %j', fixture => {
  const p = plan();
  p.furniture = [{ id: 'piece', type: 'box', position: [3, 2], fixture } as unknown as Furniture];
  expect(validatePlan(p).some(issue => issue.level === 'error' && issue.where === 'furniture piece' && issue.message.includes('fixture'))).toBe(true);
});

test.each(['door', 'double-door'] as const)('%s authored at zero starts closed and has an open endpoint', type => {
  const p = plan();
  p.openings = [{ id: 'door', wall: 'wall', type, offset: 3, width: 1.8, openAngle: 0 }];
  const openings = buildOpenings(p, () => new THREE.MeshStandardMaterial());
  const leaves: THREE.Object3D[] = [];
  openings.traverse(o => { if (o.userData.kind === 'door-leaf') leaves.push(o); });
  expect(leaves).toHaveLength(type === 'door' ? 1 : 2);
  for (const leaf of leaves) {
    expect(leaf.rotation.y).toBeCloseTo(0);
    expect(Math.abs(leaf.userData.open)).toBeCloseTo(THREE.MathUtils.degToRad(75));
    expect(leaf.userData.closed).toBe(0);
  }
  const door = openingDoors(openings).get('door')!;
  expect(door.t).toBe(0);
  expect(door.target).toBe(0);
  expect(door.closedBox.containsPoint(new THREE.Vector3(3, 1, 0))).toBe(true);
  poseDoor(door, 1);
  expect(leaves.every(leaf => Math.abs(leaf.rotation.y) > 1)).toBe(true);
  poseDoor(door, 0);
  expect(leaves.every(leaf => leaf.rotation.y === 0)).toBe(true);
});

test.each([75, -40])('authored angle %s preserves hinge and swing direction', openAngle => {
  for (const type of ['door', 'double-door'] as const) for (const hinge of ['start', 'end'] as const) for (const swing of ['left', 'right'] as const) {
    const p = plan();
    p.openings = [{ id: 'door', wall: 'wall', type, offset: 3, width: 1, openAngle, hinge, swing }];
    const openings = buildOpenings(p, () => new THREE.MeshStandardMaterial());
    const door = openingDoors(openings).get('door')!;
    expect(door.t).toBe(1);
    expect(door.target).toBe(1);
    poseDoor(door, 0);
    poseDoor(door, 1);
    openings.traverse(leaf => {
      if (leaf.userData.kind !== 'door-leaf') return;
      const direction = type === 'double-door' ? (leaf.position.x < 0 ? 1 : -1) : (hinge === 'end' ? -1 : 1);
      const angle = THREE.MathUtils.degToRad(openAngle) * direction * (swing === 'left' ? 1 : -1);
      expect(leaf.rotation.y).toBeCloseTo(angle);
      expect(leaf.userData.open).toBeCloseTo(angle);
    });
  }
});

test.each([0, 45])('sliding fixed panel blocks walking on a %s degree wall with furniture hidden', async degrees => {
  const p = plan();
  const radians = THREE.MathUtils.degToRad(degrees);
  p.walls[0].b = [8 * Math.cos(radians), 8 * Math.sin(radians)];
  p.openings = [{ id: 'slider', wall: 'wall', type: 'sliding-door', offset: 3, width: 3 }];
  const lib = new MaterialLibrary(p, () => undefined);
  const house = await buildHouse(p, lib, { resolveUrl: () => undefined });
  const position = (x: number, z: number) => new THREE.Vector3((3 + x) * Math.cos(radians) - z * Math.sin(radians), 1, (3 + x) * Math.sin(radians) + z * Math.cos(radians));
  try {
    const sash = house.root.getObjectsByProperty('type', 'Group').find(o => o.userData.kind === 'door-slide')!;
    const door = openingDoors(house.root).get('slider')!;
    expect(door.t).toBe(1);
    for (const endpoint of ['closed', 'open']) {
      poseDoor(door, endpoint === 'closed' ? 0 : 1);
      expect(sash.position.x).toBe(sash.userData[endpoint]);
      house.root.updateMatrixWorld(true);
      for (const colliders of [house.colliders, house.collidersFixed]) {
        const octree = new Octree().fromGraphNode(colliders);
        const at = (x: number, z: number) => new Capsule(position(x, z), position(x, z).add(new THREE.Vector3(0, 0.5, 0)), 0.25);
        expect(!!octree.capsuleIntersect(at(-0.735, 0))).toBe(true);
        // The fixed panel's world-axis bounding box must not fill space beside a diagonal wall.
        expect(!!octree.capsuleIntersect(at(-0.735, 0.6))).toBe(false);
        expect(!!octree.capsuleIntersect(at(1.15, 0))).toBe(false);
      }
    }
  } finally { house.dispose(); lib.dispose(); }
});
