import { expect, test } from 'bun:test';
import { buildHouse } from '../src/build/house.ts';
import { BUILTIN, MaterialLibrary } from '../src/build/materials.ts';
import type { Plan } from '../src/plan/schema.ts';
import { buildTourPath } from '../src/viewer/tour.ts';

test('a tour walks through the open gap of an interior sliding door', async () => {
  const plan: Plan = {
    version: 1, name: 'Interior sliding door',
    walls: [
      { id: 'north', a: [0, 0], b: [6, 0] },
      { id: 'east', a: [6, 0], b: [6, 5] },
      { id: 'south', a: [6, 5], b: [0, 5] },
      { id: 'west', a: [0, 5], b: [0, 0] },
      { id: 'partition', a: [3, 0], b: [3, 5] },
    ],
    openings: [{ id: 'slider', wall: 'partition', type: 'sliding-door', offset: 2.5, width: 2.4 }],
    rooms: [
      { id: 'left', name: 'Left', polygon: [[0, 0], [3, 0], [3, 5], [0, 5]] },
      { id: 'right', name: 'Right', polygon: [[3, 0], [6, 0], [6, 5], [3, 5]] },
    ],
    cameras: [
      { id: 'left-view', room: 'left', position: [1.5, 2.5], lookAt: [3, 2.5] },
      { id: 'right-view', room: 'right', position: [4.5, 2.5], lookAt: [6, 2.5] },
    ],
    tour: ['left', 'right'],
    materials: Object.fromEntries(Object.keys(BUILTIN).map(key => [key, { color: '#ffffff' }])),
  };
  const library = new MaterialLibrary(plan, () => undefined);
  const house = await buildHouse(plan, library, { resolveUrl: () => undefined });
  try {
    const path = buildTourPath({
      plan, colliders: house.colliders, reducedMotion: false,
      rooms: house.rooms.map(room => ({
        id: room.room.id, name: room.room.name, area: room.netArea,
        centroid: [room.center.x, room.center.z],
      })),
    });
    let maxHeight = 0;
    for (let time = 0; time <= path.duration; time += 0.05) {
      maxHeight = Math.max(maxHeight, path.frame(time, 1.6).position.y);
    }
    expect(maxHeight).toBeLessThanOrEqual(1.7);
  } finally {
    house.dispose();
    library.dispose();
  }
});
