import type { Plan, Wall } from './schema.ts';
import { withDefaults } from './schema.ts';

/**
 * A face someone can paint, by id: `floor:<room>`, `ceiling:<room>`, `wall:<room>:<wall>` (that
 * room's side of a wall), `outside:<wall>` (its faces with no room beside them) and
 * `furniture:<piece>:material` or `furniture:<piece>:accent`.
 */
export type Surface =
  | { kind: 'floor' | 'ceiling'; room: string }
  | { kind: 'wall'; room: string; wall: string }
  | { kind: 'outside'; wall: string }
  | { kind: 'furniture'; piece: string; slot: 'material' | 'accent' };

export function surfaceId(s: Surface) {
  switch (s.kind) {
    case 'floor':
    case 'ceiling':
      return `${s.kind}:${s.room}`;
    case 'wall':
      return `wall:${s.room}:${s.wall}`;
    case 'outside':
      return `outside:${s.wall}`;
    case 'furniture':
      return `furniture:${s.piece}:${s.slot}`;
  }
}

export function surfaceOf(id: string): Surface | null {
  const [kind, a, b, ...rest] = id.split(':');
  if (rest.length || !a) return null;
  if ((kind === 'floor' || kind === 'ceiling') && b === undefined) return { kind, room: a };
  if (kind === 'wall' && b) return { kind, room: a, wall: b };
  if (kind === 'outside' && b === undefined) return { kind, wall: a };
  if (kind === 'furniture' && (b === 'material' || b === 'accent')) return { kind, piece: a, slot: b };
  return null;
}

/** Finish of a wall face: the room's own choice for that wall, its wall finish, or the defaults. */
export function wallFaceFinish(plan: Plan, wall: Wall, room: { wallFinish?: string; wallFinishes?: Record<string, string> } | null) {
  const d = withDefaults(plan);
  if (room) return room.wallFinishes?.[wall.id] ?? room.wallFinish ?? d.interiorFinish;
  return wall.outsideFinish ?? (wall.exterior ? d.exteriorFinish : d.interiorFinish);
}

/** Material key or colour a surface uses, without design options; undefined for a piece's own default, or a surface that is gone. */
export function surfaceFinish(plan: Plan, id: string): string | undefined {
  const s = surfaceOf(id);
  if (!s) return undefined;
  const d = withDefaults(plan);
  const room = 'room' in s ? plan.rooms?.find((r) => r.id === s.room) : undefined;
  switch (s.kind) {
    case 'floor':
      return room && (room.floor ?? d.floor);
    case 'ceiling':
      return room && (room.ceiling || d.ceiling);
    case 'wall': {
      const wall = plan.walls.find((w) => w.id === s.wall);
      return room && wall && wallFaceFinish(plan, wall, room);
    }
    case 'outside': {
      const wall = plan.walls.find((w) => w.id === s.wall);
      return wall && wallFaceFinish(plan, wall, null);
    }
    case 'furniture':
      return plan.furniture?.find((f) => f.id === s.piece)?.[s.slot];
  }
}

/** Gives a surface a finish in place; false when its room, wall or piece is gone. */
export function paintSurface(plan: Plan, id: string, key: string) {
  const s = surfaceOf(id);
  if (!s) return false;
  if (s.kind === 'furniture') {
    const piece = plan.furniture?.find((f) => f.id === s.piece);
    if (piece) piece[s.slot] = key;
    return !!piece;
  }
  if (s.kind === 'outside') {
    const wall = plan.walls.find((w) => w.id === s.wall);
    if (wall) wall.outsideFinish = key;
    return !!wall;
  }
  const room = plan.rooms?.find((r) => r.id === s.room);
  if (!room) return false;
  if (s.kind === 'floor') room.floor = key;
  else if (s.kind === 'ceiling') room.ceiling = key;
  else if (s.kind === 'wall') {
    const wall = s.wall;
    if (!plan.walls.some((w) => w.id === wall)) return false;
    room.wallFinishes = { ...room.wallFinishes, [wall]: key };
  }
  return true;
}
