// Builds the structural shell from plan.js: walls with openings, floor and ceiling slabs.
import * as THREE from 'three';
import { H, EXT, rooms, walls, openings, roomAt } from './plan.js';
import { worldUV } from './lib.js';

const SLAB = 0.25; // ceiling/roof slab thickness above H

export function wallAxis(w) {
  return (w.x1 - w.x0) >= (w.z1 - w.z0) ? 'x' : 'z';
}

/**
 * Wall surface lookup: which room (or 'exterior') a point just in front of a face belongs to.
 * Points inside walls or outside every interior room count as exterior.
 */
function faceOwner(x, z) {
  const id = roomAt(x, z);
  if (!id || rooms[id].outdoor) return 'exterior';
  return id;
}

/**
 * @param materialFor (surfaceId) => Material. surfaceId is a room id, 'exterior' or 'reveal'.
 */
export function buildWalls(materialFor) {
  const group = new THREE.Group();
  group.name = 'walls';
  const colliders = [];

  for (const w of walls) {
    const axis = wallAxis(w);
    const top = w.ext ? H + SLAB : H;
    const [a0, a1] = axis === 'x' ? [w.x0, w.x1] : [w.z0, w.z1];
    const ops = openings.filter((o) => o.wall === w.id).sort((a, b) => a.a0 - b.a0);
    const pieces = []; // [s0, s1, y0, y1]
    let cursor = a0;
    for (const o of ops) {
      if (o.a0 > cursor) pieces.push([cursor, o.a0, 0, top]);
      if (o.y0 > 0) pieces.push([o.a0, o.a1, 0, o.y0]);
      pieces.push([o.a0, o.a1, o.y1, top]);
      cursor = o.a1;
    }
    if (cursor < a1) pieces.push([cursor, a1, 0, top]);

    for (const [s0, s1, y0, y1] of pieces) {
      const [x0, x1, z0, z1] = axis === 'x' ? [s0, s1, w.z0, w.z1] : [w.x0, w.x1, s0, s1];
      group.add(wallBox(x0, z0, x1, z1, y0, y1, axis, materialFor));
      if (y0 === 0 && y1 > 0.5) colliders.push({ x0, z0, x1, z1 }); // full walls and window sills
    }
  }
  return { group, colliders };
}

function wallBox(x0, z0, x1, z1, y0, y1, axis, materialFor) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  g.translate(cx, cy, cz);
  worldUV(g);
  // BoxGeometry groups: +x, -x, +y, -y, +z, -z
  const normals = [[1, 0], [-1, 0], [0, 0], [0, 0], [0, 1], [0, -1]];
  const mats = normals.map(([nx, nz], i) => {
    if (i === 2 || i === 3) return materialFor('reveal');
    const alongAxis = (axis === 'x' && nx !== 0) || (axis === 'z' && nz !== 0);
    if (alongAxis) return materialFor('reveal'); // jambs of openings and hidden wall ends
    const px = nx > 0 ? x1 + 0.06 : nx < 0 ? x0 - 0.06 : cx;
    const pz = nz > 0 ? z1 + 0.06 : nz < 0 ? z0 - 0.06 : cz;
    return materialFor(faceOwner(px, pz));
  });
  const m = new THREE.Mesh(g, mats);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Structural floor slab under the whole house and the ceiling/roof slab above it. */
export function buildSlabs(floorMat, ceilingMat) {
  const group = new THREE.Group();
  group.name = 'slabs';
  const floor = new THREE.Mesh(new THREE.BoxGeometry(EXT.x1 - EXT.x0, 0.45, EXT.z1 - EXT.z0), floorMat);
  floor.geometry.translate((EXT.x0 + EXT.x1) / 2, -0.225, (EXT.z0 + EXT.z1) / 2);
  worldUV(floor.geometry);
  floor.receiveShadow = true;
  group.add(floor);

  const ceil = new THREE.Mesh(new THREE.BoxGeometry(EXT.x1 - EXT.x0, SLAB, EXT.z1 - EXT.z0), ceilingMat);
  ceil.geometry.translate((EXT.x0 + EXT.x1) / 2, H + SLAB / 2, (EXT.z0 + EXT.z1) / 2);
  worldUV(ceil.geometry);
  ceil.castShadow = true;
  ceil.receiveShadow = true;
  group.add(ceil);
  return group;
}

/** Plan rectangle of an opening (the hole through its wall). */
export function openingRect(o) {
  if (!o.wall) {
    return o.axis === 'x'
      ? { x0: o.at - 0.05, x1: o.at + 0.05, z0: o.a0, z1: o.a1, axis: 'z' }
      : { x0: o.a0, x1: o.a1, z0: o.at - 0.05, z1: o.at + 0.05, axis: 'x' };
  }
  const w = walls.find((v) => v.id === o.wall);
  const axis = wallAxis(w);
  return axis === 'x'
    ? { x0: o.a0, x1: o.a1, z0: w.z0, z1: w.z1, axis }
    : { x0: w.x0, x1: w.x1, z0: o.a0, z1: o.a1, axis };
}
