import * as THREE from 'three/webgpu';

export interface Door {
  id: string;
  parts: THREE.Object3D[];
  t: number;
  target: number;
  moving: boolean;
  closedBox: THREE.Box3;
}

export function poseDoor(door: Door, openness: number) {
  for (const part of door.parts) {
    const value = part.userData.closed + (part.userData.open - part.userData.closed) * openness;
    if (part.userData.kind === 'door-slide') part.position.x = value;
    else part.rotation.y = value;
  }
}

/** Capture the authored pose before measuring each door's closed walking blocker. */
export function openingDoors(root: THREE.Object3D) {
  const doors = new Map<string, Door>();
  root.updateMatrixWorld(true);
  root.traverse(opening => {
    if (opening.userData.kind !== 'opening') return;
    const parts: THREE.Object3D[] = [];
    opening.traverse(part => { if (part.userData.dynamic) parts.push(part); });
    if (!parts.length) return;
    const initial = parts.every(part =>
      (part.userData.kind === 'door-slide' ? part.position.x : part.rotation.y) === part.userData.closed,
    ) ? 0 : 1;
    const door: Door = { id: opening.userData.id, parts, t: initial, target: initial, moving: false, closedBox: new THREE.Box3() };
    poseDoor(door, 0);
    opening.updateMatrixWorld(true);
    for (const part of parts) door.closedBox.expandByObject(part);
    door.closedBox.expandByScalar(0.02);
    poseDoor(door, initial);
    opening.updateMatrixWorld(true);
    doors.set(door.id, door);
  });
  return doors;
}
