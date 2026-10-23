import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { buildHouse, type BuiltHouse } from '../src/build/house.ts';
import { BUILTIN, MaterialLibrary } from '../src/build/materials.ts';
import { addFurniture, NO_EDITS, paintSurfaces, placeFurniture, removeFurniture } from '../src/plan/edits.ts';
import type { Plan } from '../src/plan/schema.ts';
import { createEditor } from '../src/viewer/editor.ts';

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

/** One room with a table, a cabinet that is a fixture and an interior wall splitting off a hall. */
const plan = (): Plan => ({
  version: 1,
  name: 'Editor test',
  walls: [
    { id: 'n', a: [0, 0], b: [8, 0], exterior: true },
    { id: 'e', a: [8, 0], b: [8, 4], exterior: true },
    { id: 's', a: [8, 4], b: [0, 4], exterior: true },
    { id: 'w', a: [0, 4], b: [0, 0], exterior: true },
    { id: 'split', a: [6, 0], b: [6, 4] },
  ],
  rooms: [
    { id: 'living', name: 'Living', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], floor: 'living-floor' },
    { id: 'hall', name: 'Hall', polygon: [[6, 0], [8, 0], [8, 4], [6, 4]] },
  ],
  furniture: [
    { id: 'table', type: 'box', position: [3, 2], size: [1, 1, 0.75] },
    { id: 'cabinet', type: 'box', fixture: true, position: [1, 0.6], size: [0.8, 0.5, 1.2] },
  ],
  materials: { ...Object.fromEntries(Object.keys(BUILTIN).map((key) => [key, { color: '#ffffff' }])), 'living-floor': { color: '#888888' } },
});

async function editable() {
  const p = plan();
  const lib = new MaterialLibrary(p, () => undefined);
  const house = (await buildHouse(p, lib, { resolveUrl: () => undefined, editable: true })) as BuiltHouse & { editor: NonNullable<BuiltHouse['editor']> };
  const abort = new AbortController();
  cleanup.push(() => {
    abort.abort();
    house.dispose();
    lib.dispose();
  });
  const placed: [string, number[], number][] = [];
  const editor = createEditor({
    house, plan: p, canvas: new EventTarget() as HTMLCanvasElement, scene: new THREE.Scene(), camera: () => new THREE.PerspectiveCamera(),
    allowed: () => true, floorHeight: () => 0, designOption: () => null, aim: () => undefined, holdCamera: () => undefined,
    changed: () => undefined, report: () => undefined, catalog: () => ({ models: [], textures: [] }), reloadCatalog: async () => undefined, picture: async () => "", signal: abort.signal,
  });
  editor.listen({ onSelect: () => undefined, onPlace: (id, position, rotation) => placed.push([id, position, rotation]) });
  await editor.start();
  return { house, editor, placed };
}

const meshCount = (o: THREE.Object3D) => {
  let n = 0;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) n++;
  });
  return n;
};

const floorOf = (house: BuiltHouse, room: string) => {
  let found: THREE.Mesh | undefined;
  house.floors.traverse((o) => {
    if (o.userData.surface === `floor:${room}`) found = o as THREE.Mesh;
  });
  return found!;
};

test('an editable house keeps each piece and surface apart, with its plan id', async () => {
  const { house } = await editable();
  expect([...house.editor.pieces.keys()].sort()).toEqual(['cabinet', 'table']);
  expect(floorOf(house, 'living')).toBeDefined();
  const split = house.walls.children.find((o) => o.userData.id === 'split')!;
  // Faces +z and −z: walking a to b, south down the plan, the living room lies to the right (west).
  expect(split.userData.surfaces.slice(4)).toEqual(['wall:living:split', 'wall:hall:split']);
});

test('edits move, remove, add and paint in place, and setting the earlier edits undoes them', async () => {
  const { house, editor } = await editable();
  const table = house.editor.pieces.get('table')!;
  const before = floorOf(house, 'living').material;
  let edits = placeFurniture(NO_EDITS, 'table', [4, 3], 90);
  edits = removeFurniture(edits, 'cabinet');
  edits = addFurniture(edits, { id: 'box-2', type: 'box', position: [1, 3], size: [0.5, 0.5, 0.5] });
  edits = paintSurfaces(edits, editor.plan(), ['floor:living'], { color: '#c96f4a' }, null);
  await editor.setEdits(edits);
  expect(house.editor.pieces.get('table')).toBe(table);
  expect([table.position.x, table.position.z]).toEqual([4, 3]);
  expect(table.rotation.y).toBeCloseTo(-Math.PI / 2, 6);
  expect(house.editor.pieces.has('cabinet')).toBe(false);
  expect(house.editor.pieces.get('box-2')!.parent).toBeTruthy();
  const painted = floorOf(house, 'living').material as THREE.MeshStandardMaterial;
  expect(`#${painted.color.getHexString()}`).toBe('#c96f4a');

  await editor.setEdits(NO_EDITS);
  expect([table.position.x, table.position.z]).toEqual([3, 2]);
  expect(house.editor.pieces.has('cabinet')).toBe(true);
  expect(house.editor.pieces.has('box-2')).toBe(false);
  expect(floorOf(house, 'living').material).toBe(before);
});

test('a paint key used again after an undo gets its new finish, not the old one', async () => {
  const { house, editor } = await editable();
  await editor.setEdits(paintSurfaces(NO_EDITS, editor.plan(), ['floor:living'], { color: '#111111' }, null));
  await editor.setEdits(NO_EDITS);
  await editor.setEdits(paintSurfaces(NO_EDITS, editor.plan(), ['floor:living'], { color: '#222222' }, null));
  expect(`#${(floorOf(house, 'living').material as THREE.MeshStandardMaterial).color.getHexString()}`).toBe('#222222');
});

test('fixtures are locked, turning checks for room, and Shift+drop finds every surface with a finish', async () => {
  const { editor, placed } = await editable();
  expect(editor.locked('cabinet')).toBe(true);
  expect(editor.locked('table')).toBe(false);
  expect(editor.turn('cabinet', 90)).toBe(false);
  expect(editor.turn('table', 90)).toBe(true);
  expect(placed).toEqual([['table', [3, 2], 90]]);
  expect(editor.surfacesWith('living-floor')).toEqual(['floor:living']);
  // The hall floor and the box pieces' default finish are distinct keys.
  expect(editor.surfacesWith('paint-white').sort()).toContain('wall:hall:split');
});

test('a new piece fits at the nearest free spot', async () => {
  const { editor } = await editable();
  // Straight onto the table: it moves off to the nearest spot clear of it.
  const at = editor.fit({ id: 'box-3', type: 'box', position: [0, 0], size: [0.5, 0.5, 0.5] }, [3, 2])!;
  expect(Math.max(Math.abs(at[0] - 3), Math.abs(at[1] - 2))).toBeGreaterThanOrEqual(0.74);
  expect(editor.fit({ id: 'box-4', type: 'box', position: [0, 0], size: [9, 9, 0.5] }, [3, 2])).toBeNull();
});

test('painting one side of a wall leaves the other side and the other walls alone', async () => {
  const { house, editor } = await editable();
  const split = house.walls.children.filter((o) => o.userData.id === 'split') as THREE.Mesh[];
  const hall = (split[0].material as THREE.Material[])[5];
  await editor.setEdits(paintSurfaces(NO_EDITS, editor.plan(), ['wall:living:split'], { color: '#2f3d55' }, null));
  for (const piece of split) {
    const [living, other] = [(piece.material as THREE.MeshStandardMaterial[])[4], (piece.material as THREE.Material[])[5]];
    expect(`#${living.color.getHexString()}`).toBe('#2f3d55');
    expect(other).toBe(hall);
  }
  const north = house.walls.children.find((o) => o.userData.id === 'n') as THREE.Mesh;
  expect(((north.material as THREE.MeshStandardMaterial[]).map((m) => `#${m.color.getHexString()}`))).not.toContain('#2f3d55');
});

test('an editable house shows merged until editing starts, and merges again when it stops', async () => {
  const { house, editor } = await editable();
  const apart = meshCount(house.root);
  await editor.stop();
  const merged = meshCount(house.root);
  expect(merged).toBeLessThan(apart);
  expect(floorOf(house, 'living')).toBeUndefined();
  const ids = () => {
    const out: string[] = [];
    house.root.traverse((o) => void out.push(o.uuid));
    return out.sort();
  };
  const mergedIds = ids();

  // Nothing changed while apart: the same merged meshes come back.
  await editor.start();
  expect(meshCount(house.root)).toBe(apart);
  await editor.stop();
  expect(ids()).toEqual(mergedIds);

  // A painted floor merges again with its new finish.
  await editor.start();
  await editor.setEdits(paintSurfaces(NO_EDITS, editor.plan(), ['floor:living'], { color: '#c96f4a' }, null));
  await editor.stop();
  const colors = new Set<string>();
  house.floors.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m?.color) colors.add(`#${m.color.getHexString()}`);
  });
  expect(colors.has('#c96f4a')).toBe(true);
  expect(ids()).not.toEqual(mergedIds);
  expect(meshCount(house.root)).toBe(merged);
});
