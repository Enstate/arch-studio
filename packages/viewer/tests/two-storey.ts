import { BUILTIN } from '../src/build/materials.ts';
import type { Plan, Vec2 } from '../src/plan/schema.ts';

const shell = (level: string): Plan['walls'] => {
  const corners: Vec2[] = [[0, 0], [8, 0], [8, 6], [0, 6]];
  return [
    ...corners.map((a, i) => ({ id: `${level}-outer-${i}`, level, a, b: corners[(i + 1) % 4], exterior: true })),
    { id: `${level}-partition`, level, a: [5, 0], b: [5, 6] },
  ];
};

/**
 * A synthetic two-storey house: a living room and a stair hall below, a bedroom and a landing
 * above, joined by one straight flight that climbs north through the hall.
 */
export const twoStorey: Plan = {
  version: 1,
  name: 'Two-storey test house',
  defaults: { wallHeight: 2.6 },
  levels: [
    { id: 'ground', name: 'Ground floor', elevation: 0, height: 2.8 },
    { id: 'upper', name: 'Upper floor', elevation: 2.8, height: 2.6 },
  ],
  walls: [...shell('ground'), ...shell('upper')],
  openings: [
    { id: 'front-door', wall: 'ground-outer-2', type: 'door', offset: 1.5, width: 0.9 },
    { id: 'hall-door', wall: 'ground-partition', type: 'door', offset: 3, width: 0.9 },
    { id: 'bedroom-door', wall: 'upper-partition', type: 'door', offset: 0.8, width: 0.9 },
    { id: 'bedroom-window', wall: 'upper-outer-3', type: 'window', offset: 3, width: 1.4 },
  ],
  rooms: [
    { id: 'living', level: 'ground', name: 'Living', polygon: [[0, 0], [5, 0], [5, 6], [0, 6]], ceilingHeight: 2.6 },
    { id: 'hall', level: 'ground', name: 'Hall', polygon: [[5, 0], [8, 0], [8, 6], [5, 6]], ceilingHeight: 2.6 },
    { id: 'bedroom', level: 'upper', name: 'Bedroom', polygon: [[0, 0], [5, 0], [5, 6], [0, 6]] },
    { id: 'landing', level: 'upper', name: 'Landing', polygon: [[5, 0], [8, 0], [8, 6], [5, 6]] },
  ],
  furniture: [
    { id: 'flight', type: 'stairs', level: 'ground', room: 'hall', position: [7.15, 3.3], size: [1.1, 3.8, 2.8] },
    { id: 'sofa', type: 'box', fixture: true, level: 'ground', room: 'living', position: [2.5, 4.5], size: [2, 0.9, 0.8] },
    { id: 'bed', type: 'box', fixture: true, level: 'upper', room: 'bedroom', position: [2.5, 3], size: [1.6, 2.1, 0.5] },
  ],
  cameras: [
    { id: 'living-view', level: 'ground', room: 'living', position: [4, 5], lookAt: [1, 1] },
    { id: 'bedroom-view', level: 'upper', room: 'bedroom', position: [4.2, 5.2], lookAt: [1, 1] },
  ],
  materials: Object.fromEntries(Object.keys(BUILTIN).map((key) => [key, { color: '#ffffff' }])),
};
