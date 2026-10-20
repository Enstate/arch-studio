import * as THREE from 'three/webgpu';
import type { Plan, Vec2 } from '../plan/schema.ts';
import { withDefaults } from '../plan/schema.ts';
import { wallDir, wallThickness, roomAt, polygonCentroid, polygonArea, pointInPolygon } from '../plan/geom.ts';
import { CUT_HEIGHT, NO_CUT } from '../build/house.ts';
import type { RoomInfo } from '../viewer.ts';

export type TourStatus = 'idle' | 'playing' | 'paused' | 'done';

export interface TourState {
  status: TourStatus;
  /** 0..1 over the whole tour. */
  progress: number;
  roomId?: string;
  roomName?: string;
  /** Net floor area in m². */
  roomArea?: number;
}

export interface Tour {
  /** Starts the whole tour (plan-to-house reveal, then room by room), or resumes a paused one. */
  play(): void;
  pause(): void;
  /** Ends the tour and returns to the view it started from. */
  stop(): void;
  /** Jumps to `seconds` into the tour; a stopped tour opens paused there. */
  seek(seconds: number): void;
  /** Plays only the plan-to-house reveal, then hands over to walk mode at the front door. */
  reveal(): void;
  /** Length of the whole tour in seconds. */
  readonly duration: number;
}

export const IDLE_TOUR: TourState = { status: 'idle', progress: 0 };

/** Everything the viewer draws for one moment of the tour. */
export interface TourFrame {
  position: THREE.Vector3;
  /** Walker convention: yaw 0 looks along −z; negative pitch looks down. */
  yaw: number;
  pitch: number;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Distance to what the camera looks at, for the clip planes. */
  focus: number;
  /** Height of the horizontal cut plane; NO_CUT when nothing is cut. */
  cut: number;
  /** Inside the house: walk-mode sky and exposure instead of the paper overview. */
  inside: boolean;
  /** Room name labels on the plan (the reveal's opening view). */
  labels: boolean;
  roomId: string | null;
}

const EYE = 1.55;
const SPEED = 0.95;
const DWELL = 2.3;
const REVEAL_HOLD = 1.2;
const REVEAL_MOVE = 10;
/** Where the reveal hands over: this far outside the front door, at eye height. */
export const OUTSIDE = 4.5;
/** Cut heights above this clear the roof slab, so the cut turns off. */
const ROOF_CUT = 3.4;
const REDUCED_STOP = 3.5;

interface Key {
  p: THREE.Vector3;
  yaw: number;
  pitch: number;
  fov: number;
  /** Seconds the camera rests here; dwell keys present a room. */
  dwell: number;
  room?: string;
}

interface Connector {
  c: Vec2;
  /** Unit normal; `a` lies on its negative side, `b` on its positive side. */
  n: Vec2;
  a: string | null;
  b: string | null;
}

interface Leg {
  from: number;
  to: number;
  start: number;
  duration: number;
  lengths: number[];
  total: number;
}

export interface TourPath {
  duration: number;
  /** Seconds at which the reveal ends at the front door. */
  revealEnd: number;
  frame(t: number, aspect: number): TourFrame;
}

const smooth = (x: number) => x * x * (3 - 2 * x);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeSine = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);
const forward = (yaw: number, pitch: number) =>
  new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));

/** Uniform Catmull-Rom through four values. */
function cr(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Catmull-Rom over an array of values at fractional index `u`, with clamped ends. */
function crAt(values: number[], u: number) {
  const n = values.length;
  if (n === 1) return values[0];
  const i = Math.min(n - 2, Math.max(0, Math.floor(u)));
  const t = Math.min(1, u - i);
  const v = (k: number) => values[Math.min(n - 1, Math.max(0, k))];
  return cr(v(i - 1), v(i), v(i + 1), v(i + 2), t);
}

/** Yaw angles made continuous, so interpolation turns the short way round. */
function unwrap(yaws: number[]) {
  const out = [...yaws];
  for (let i = 1; i < out.length; i++) {
    while (out[i] - out[i - 1] > Math.PI) out[i] -= Math.PI * 2;
    while (out[i] - out[i - 1] < -Math.PI) out[i] += Math.PI * 2;
  }
  return out;
}

export interface TourInput {
  plan: Plan;
  rooms: RoomInfo[];
  /** Invisible collision copies of walls, floors and furniture (the walker's world). */
  colliders: THREE.Object3D;
  reducedMotion: boolean;
}

/**
 * Builds the guided path from the plan: a long-lens plan view that opens into perspective while
 * the cut rises to full walls, down to the front door, then room by room through door centres.
 * Rooms come in order of the shortest walk; `plan.tour` (room or camera ids) overrides the order
 * and `plan.cameras` the view in a room. Every step is checked against the walker's colliders;
 * a step that would pass through a wall lifts the camera over the cut instead.
 */
export function buildTourPath({ plan, rooms, colliders, reducedMotion }: TourInput): TourPath {
  const d = withDefaults(plan);
  const ray = new THREE.Raycaster();
  colliders.updateMatrixWorld(true);
  const solids = colliders.children;
  const v3 = (p: Vec2, y = EYE) => new THREE.Vector3(p[0], y, p[1]);

  /** True when a person's eye line from a to b passes no wall or tall furniture. */
  function clear(a: THREE.Vector3, b: THREE.Vector3) {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-3) return true;
    dir.divideScalar(len);
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(0.12);
    for (const off of [0, 1, -1]) {
      ray.set(a.clone().addScaledVector(side, off), dir);
      ray.far = len;
      if (ray.intersectObjects(solids, false).length) return false;
    }
    return true;
  }

  const connectors: Connector[] = [];
  let front: Connector | null = null;
  for (const o of plan.openings ?? []) {
    if (o.type === 'window' || o.type === 'garage-door') continue;
    const w = plan.walls.find((x) => x.id === o.wall);
    if (!w) continue;
    const dir = wallDir(w);
    const c: Vec2 = [w.a[0] + dir[0] * o.offset, w.a[1] + dir[1] * o.offset];
    const n: Vec2 = [-dir[1], dir[0]];
    const reach = wallThickness(plan, w) / 2 + 0.3;
    const a = roomAt(plan, [c[0] - n[0] * reach, c[1] - n[1] * reach])?.id ?? null;
    const b = roomAt(plan, [c[0] + n[0] * reach, c[1] + n[1] * reach])?.id ?? null;
    if (!a && !b) continue;
    const con = { c, n, a, b };
    if (a && b) connectors.push(con);
    else if (!front && o.type === 'door' && w.exterior) front = con;
  }
  const info = new Map(rooms.map((r) => [r.id, r]));
  const polygon = (id: string) => plan.rooms?.find((r) => r.id === id)?.polygon ?? [];
  const into = (con: Connector, room: string): Vec2 => (con.b === room ? con.n : [-con.n[0], -con.n[1]]);

  const byArea = [...rooms].sort((x, y) => y.area - x.area);
  const entryRoom = front ? (front.a ?? front.b)! : byArea[0]?.id;
  const outward: Vec2 = front ? (front.a ? front.n : [-front.n[0], -front.n[1]]) : [0, 1];

  /** Shortest door chain from room x to room y (fewest doors, then shortest walk). */
  function route(x: string, y: string): Connector[] {
    const best = new Map<string, { cost: number; via: Connector[]; at: Vec2 }>([[x, { cost: 0, via: [], at: info.get(x)?.centroid ?? [0, 0] }]]);
    const queue = [x];
    while (queue.length) {
      queue.sort((p, q) => best.get(p)!.cost - best.get(q)!.cost);
      const cur = queue.shift()!;
      const here = best.get(cur)!;
      for (const con of connectors) {
        const next = con.a === cur ? con.b : con.b === cur ? con.a : null;
        if (!next) continue;
        const cost = here.cost + 100 + Math.hypot(con.c[0] - here.at[0], con.c[1] - here.at[1]);
        if (cost < (best.get(next)?.cost ?? Infinity)) {
          best.set(next, { cost, via: [...here.via, con], at: con.c });
          queue.push(next);
        }
      }
    }
    return best.get(y)?.via ?? [];
  }

  // Room order: plan.tour if given, else always the nearest room not yet shown.
  const cameraFor = new Map<string, NonNullable<Plan['cameras']>[number]>();
  let order: string[] = [];
  const authored = plan.tour;
  if (authored?.length) {
    for (const id of authored) {
      const cam = plan.cameras?.find((c) => c.id === id);
      const room = cam?.room ?? (info.has(id) ? id : undefined);
      if (!room) continue;
      if (cam) cameraFor.set(room, cam);
      if (!order.includes(room)) order.push(room);
    }
  }
  if (!order.length && entryRoom) {
    order = [entryRoom];
    const left = new Set(rooms.map((r) => r.id).filter((id) => id !== entryRoom));
    while (left.size) {
      const cur = order[order.length - 1];
      let pick: string | null = null, cost = Infinity;
      for (const id of left) {
        const r = route(cur, id);
        const c = r.length ? r.length * 100 + Math.hypot(r[r.length - 1].c[0] - info.get(cur)!.centroid[0], r[r.length - 1].c[1] - info.get(cur)!.centroid[1]) : Infinity;
        if (c < cost) [pick, cost] = [id, c];
      }
      if (!pick) break;
      order.push(pick);
      left.delete(pick);
    }
  }

  /** The view that presents a room, entered through `con` (or from its centre). */
  function dwellKey(room: string, con: Connector | null): Key {
    const cam = cameraFor.get(room) ?? plan.cameras?.find((c) => c.room === room);
    if (cam) {
      const p = v3(cam.position, cam.height ? Math.min(cam.height, 1.7) : EYE);
      const t = v3(cam.lookAt, cam.lookAtHeight ?? 1.2);
      return { p, yaw: yawOf(t.x - p.x, t.z - p.z), pitch: Math.atan2(t.y - p.y, Math.hypot(t.x - p.x, t.z - p.z)), fov: cam.fov ?? 60, dwell: DWELL, room };
    }
    const poly = polygon(room);
    const centroid = polygonCentroid(poly);
    const n = con ? into(con, room) : ([0, -1] as Vec2);
    let at: Vec2 = con ? [con.c[0] + n[0] * 1.1, con.c[1] + n[1] * 1.1] : centroid;
    if (!pointInPolygon(at, poly)) at = centroid;
    // Look across the room at the farthest corner the eye can actually see (L-shaped halls).
    let look: Vec2 = centroid, dist = 0;
    for (const q of poly) {
      const cand: Vec2 = [q[0] * 0.65 + centroid[0] * 0.35, q[1] * 0.65 + centroid[1] * 0.35];
      const l = Math.hypot(cand[0] - at[0], cand[1] - at[1]);
      if (l > dist && clear(v3(at), v3(cand))) [look, dist] = [cand, l];
    }
    if (dist < 0.5) {
      look = centroid;
      dist = Math.hypot(look[0] - at[0], look[1] - at[1]) || 1;
    }
    const area = polygonArea(poly);
    return { p: v3(at), yaw: yawOf(look[0] - at[0], look[1] - at[1]), pitch: Math.atan2(1.15 - EYE, dist), fov: area < 12 ? 66 : 58, dwell: DWELL, room };
  }

  const passKeys = (con: Connector, toward: string): Key[] => {
    const n = into(con, toward);
    const yaw = yawOf(n[0], n[1]);
    return [-0.65, 0, 0.65].map((s) => ({ p: v3([con.c[0] + n[0] * s, con.c[1] + n[1] * s]), yaw, pitch: -0.04, fov: 62, dwell: 0 }));
  };

  // ---------- walk keys ----------

  const keys: Key[] = [];
  if (front && entryRoom) {
    const out = v3([front.c[0] + outward[0] * OUTSIDE, front.c[1] + outward[1] * OUTSIDE]);
    const yaw = yawOf(-outward[0], -outward[1]);
    keys.push({ p: out, yaw, pitch: -0.05, fov: 55, dwell: 0 });
    keys.push(...passKeys(front, entryRoom).slice(1));
  }
  let current: string | null = null;
  const firstDwell: number[] = [];
  for (const room of order) {
    if (current) {
      const path = route(current, room);
      let here = current;
      for (const con of path) {
        const next = (con.a === here ? con.b : con.a) ?? room;
        here = next;
        const pass = passKeys(con, next);
        // A straight line through the room between two doors can clip a corner (L-shaped halls).
        const prev = keys[keys.length - 1];
        if (prev && !clear(prev.p, pass[0].p)) {
          const transit = roomAt(plan, [prev.p.x, prev.p.z]);
          const poly = transit?.polygon ?? [];
          const cen = polygonCentroid(poly);
          const candidates = [cen, ...poly.map((q) => [q[0] + (cen[0] - q[0]) * 0.35, q[1] + (cen[1] - q[1]) * 0.35] as Vec2)];
          let best: Vec2 | null = null, len = Infinity;
          for (const q of candidates) {
            const w = v3(q);
            const l = prev.p.distanceTo(w) + w.distanceTo(pass[0].p);
            if (l < len && clear(prev.p, w) && clear(w, pass[0].p)) [best, len] = [q, l];
          }
          if (best) keys.push({ p: v3(best), yaw: yawOf(pass[0].p.x - best[0], pass[0].p.z - best[1]), pitch: -0.04, fov: 62, dwell: 0 });
        }
        keys.push(...pass);
      }
      const con = path[path.length - 1] ?? null;
      firstDwell.push(keys.length);
      keys.push(dwellKey(room, con));
    } else {
      const con = front && (front.a === room || front.b === room) ? front : null;
      firstDwell.push(keys.length);
      keys.push(dwellKey(room, con));
    }
    current = room;
  }
  if (!keys.length) keys.push({ p: new THREE.Vector3(0, EYE, 0), yaw: 0, pitch: 0, fov: 60, dwell: 0 });

  const curve = new THREE.CatmullRomCurve3(keys.map((k) => k.p), false, 'centripetal');
  const yaws = unwrap(keys.map((k) => k.yaw));
  const pitches = keys.map((k) => k.pitch);
  const fovs = keys.map((k) => Math.log(k.fov));
  const n = keys.length;
  const at = (u: number) => curve.getPoint(n > 1 ? Math.min(1, Math.max(0, u / (n - 1))) : 0);

  // Segments that still pass through a wall after smoothing go over the cut instead.
  const over = keys.map((_, i) => {
    if (i >= n - 1) return false;
    for (let s = 0; s < 8; s++) if (!clear(at(i + s / 8), at(i + (s + 1) / 8))) return true;
    return false;
  });

  // ---------- timing ----------

  const revealEnd = front && !reducedMotion ? REVEAL_HOLD + REVEAL_MOVE : 0;
  const legs: Leg[] = [];
  const dwells: { key: number; start: number }[] = [];
  let clock = revealEnd;
  const stops = keys.map((k, i) => (k.dwell > 0 || i === 0 ? i : -1)).filter((i) => i >= 0);
  if (stops[stops.length - 1] !== n - 1) stops.push(n - 1);
  for (let s = 0; s < stops.length; s++) {
    const k = stops[s];
    if (keys[k].dwell > 0) {
      dwells.push({ key: k, start: clock });
      clock += reducedMotion ? REDUCED_STOP : keys[k].dwell;
    }
    const next = stops[s + 1];
    if (next === undefined || reducedMotion) continue;
    const lengths: number[] = [];
    for (let i = k; i < next; i++) lengths.push(at(i).distanceTo(at(i + 1)) + (over[i] ? 5 : 0));
    const total = lengths.reduce((a, b) => a + b, 0);
    const duration = Math.max(2, total / SPEED);
    legs.push({ from: k, to: next, start: clock, duration, lengths, total });
    clock += duration;
  }
  const duration = clock;
  const doorIndex = front ? 2 : 0;

  // ---------- reveal ----------

  const b = plan.walls.flatMap((w) => [w.a, w.b]);
  const minX = Math.min(...b.map((p) => p[0])), maxX = Math.max(...b.map((p) => p[0]));
  const minY = Math.min(...b.map((p) => p[1])), maxY = Math.max(...b.map((p) => p[1]));
  const center = new THREE.Vector3((minX + maxX) / 2, 0, (minY + maxY) / 2);
  const revealYaw = keys[0].yaw;
  const corners: Vec2[] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  const up2: Vec2 = [-Math.sin(revealYaw), -Math.cos(revealYaw)];
  const right2: Vec2 = [Math.cos(revealYaw), -Math.sin(revealYaw)];
  const extent = (axis: Vec2) => {
    const s = corners.map((q) => q[0] * axis[0] + q[1] * axis[1]);
    return Math.max(...s) - Math.min(...s);
  };
  const extV = extent(up2) + 2, extH = extent(right2) + 2;
  const wallH = d.wallHeight;

  function revealFrame(t: number, aspect: number): TourFrame {
    const p = clamp01((t - REVEAL_HOLD) / REVEAL_MOVE);
    // Keys: plan through a long lens, three-quarter overview, the front elevation, the front door.
    // Most of the time goes to opening the plan into the house; the walk up to the door is quick.
    const q = easeInOut(p);
    const e = q < 0.45 ? q / 0.45 : q < 0.8 ? 1 + (q - 0.45) / 0.35 : 2 + (q - 0.8) / 0.2;
    // Narrow screens widen the lens a little so the house still fits across.
    const widen = aspect < 1 ? (1 / aspect) ** 0.35 : 1;
    const frame = Math.max(extV, extH / aspect) * 1.12;
    const fov0 = 3.5 * widen, fov1 = 40 * widen, fov2 = 45 * widen;
    const dist0 = frame / (2 * Math.tan(THREE.MathUtils.degToRad(fov0) / 2));
    const dist1 = (frame * 1.05) / (2 * Math.tan(THREE.MathUtils.degToRad(fov1) / 2)) + 2;
    const dist2 = Math.max(12, frame);
    const end = keys[0];
    const endTarget = end.p.clone().addScaledVector(forward(end.yaw, end.pitch), OUTSIDE);
    const facade = new THREE.Vector3((center.x + endTarget.x) / 2, 1.2, (center.z + endTarget.z) / 2);
    const targets = [center.clone(), new THREE.Vector3(center.x, 0.6, center.z), facade, endTarget];
    const tx = crAt(targets.map((v) => v.x), e), ty = crAt(targets.map((v) => v.y), e), tz = crAt(targets.map((v) => v.z), e);
    const pitch = crAt([-1.5603, -0.87, -0.26, end.pitch], e);
    const fov = Math.exp(crAt([Math.log(fov0), Math.log(fov1), Math.log(fov2), Math.log(end.fov)], e));
    const focus = Math.exp(crAt([Math.log(dist0), Math.log(dist1), Math.log(dist2), Math.log(OUTSIDE)], e));
    const position = new THREE.Vector3(tx, ty, tz).addScaledVector(forward(revealYaw, pitch), -focus);
    const rise = smooth(clamp01((p - 0.12) / 0.5));
    const cut = rise >= 1 ? NO_CUT : CUT_HEIGHT + (ROOF_CUT - CUT_HEIGHT) * rise;
    return { position, yaw: revealYaw, pitch, fov, focus, cut, inside: false, labels: t < REVEAL_HOLD + 0.4, roomId: null };
  }

  // ---------- walk ----------

  function pose(u: number, drift: number, driftSign: number, legRooms: (string | undefined)[]): TourFrame {
    const position = at(u);
    let yaw = crAt(yaws, u) + driftSign * THREE.MathUtils.degToRad(1.2) * drift;
    let pitch = crAt(pitches, u);
    const fov = Math.exp(crAt(fovs, u));
    position.addScaledVector(forward(yaw, 0), 0.3 * drift);
    let cut = NO_CUT;
    const i = Math.min(n - 2, Math.floor(u));
    if (i >= 0 && over[i]) {
      const bump = Math.sin(Math.PI * (u - i));
      position.y += bump * (wallH + 1.6 - EYE);
      pitch -= bump * 0.9;
      cut = ROOF_CUT - (ROOF_CUT - CUT_HEIGHT) * Math.min(1, bump * 1.4);
      if (cut >= ROOF_CUT - 1e-3) cut = NO_CUT;
    }
    yaw = THREE.MathUtils.euclideanModulo(yaw + Math.PI, Math.PI * 2) - Math.PI;
    const here = roomAt(plan, [position.x, position.z])?.id;
    const roomId = here && legRooms.includes(here) ? here : null;
    return { position, yaw, pitch, fov, focus: 3, cut, inside: u >= doorIndex - 0.05, labels: false, roomId };
  }

  function walkFrame(t: number): TourFrame {
    for (const [j, dw] of dwells.entries()) {
      const len = reducedMotion ? REDUCED_STOP : keys[dw.key].dwell;
      if (t >= dw.start && t < dw.start + len) {
        const drift = reducedMotion ? 0 : smooth((t - dw.start) / len);
        return pose(dw.key, drift, j % 2 ? -1 : 1, [keys[dw.key].room]);
      }
    }
    for (const leg of legs) {
      if (t < leg.start || t >= leg.start + leg.duration) continue;
      const local = (t - leg.start) / leg.duration;
      const along = (leg.from === 0 && revealEnd > 0 ? easeSine(local) : easeInOut(local)) * leg.total;
      let acc = 0, u = leg.to;
      for (const [j, l] of leg.lengths.entries()) {
        if (along <= acc + l || j === leg.lengths.length - 1) {
          u = leg.from + j + (l > 0 ? clamp01((along - acc) / l) : 1);
          break;
        }
        acc += l;
      }
      const prior = dwells.findIndex((dw) => dw.key === leg.from);
      const drift = prior >= 0 ? 1 - smooth(clamp01(local / 0.4)) : 0;
      return pose(u, drift, prior % 2 ? -1 : 1, [keys[leg.from].room, keys[leg.to].room]);
    }
    const last = dwells[dwells.length - 1];
    return pose(last ? last.key : n - 1, last && !reducedMotion ? 1 : 0, (dwells.length - 1) % 2 ? -1 : 1, [last ? keys[last.key].room : undefined]);
  }

  return {
    duration,
    revealEnd,
    frame(t, aspect) {
      t = Math.min(duration, Math.max(0, t));
      return t < revealEnd ? revealFrame(t, aspect) : walkFrame(t);
    },
  };
}

// ---------- autoplay ----------

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export interface TourHost {
  element: HTMLElement;
  signal: AbortSignal;
  rooms(): RoomInfo[];
  path(): TourPath;
  /** The tour takes the camera. */
  begin(): void;
  /** Draws one tour frame. */
  apply(frame: TourFrame): void;
  /** The tour lets go: back to the view it started from, or into walk mode at `frame`. */
  end(how: 'restore' | 'walk', frame?: TourFrame): void;
  update(tour: TourState): void;
}

export interface TourController {
  tour: Tour;
  /** True while the tour holds the camera (playing or paused). */
  readonly active: boolean;
  /** Advances autoplay; call once per animation frame. */
  tick(dt: number, aspect: number): void;
  /** Ends the tour without restoring the view; the viewer is about to set its own. */
  release(): void;
}

/**
 * Autoplay, scrubbing and pausing over the pure timeline: everything feeds one time `t` into
 * `path.frame(t)`. Pointer, wheel, touch and movement keys pause; resuming is explicit.
 */
export function createTour(host: TourHost): TourController {
  let path: TourPath | null = null;
  let status: TourStatus = 'idle';
  let t = 0;
  let limit = Infinity;
  let last: TourFrame | null = null;
  let published: { status: TourStatus; roomId?: string; at: number } = { status, at: 0 };
  let aspect = 1;
  const rooms = new Map(host.rooms().map((r) => [r.id, r]));
  const getPath = () => (path ??= host.path());

  function publish(force = false) {
    const p = getPath();
    const roomId = status === 'idle' ? undefined : (last?.roomId ?? undefined);
    const now = performance.now();
    // Progress ten times a second is plenty for a progress bar; status and room go out at once.
    if (!force && status === published.status && roomId === published.roomId && now - published.at < 100) return;
    published = { status, roomId, at: now };
    const room = roomId ? rooms.get(roomId) : undefined;
    host.update({
      status,
      progress: status === 'idle' ? 0 : p.duration ? Math.min(1, t / p.duration) : 1,
      ...(room && { roomId: room.id, roomName: room.name, roomArea: room.area }),
    });
  }

  function show() {
    last = getPath().frame(t, aspect);
    host.apply(last);
  }

  function start(end: number) {
    path = null;
    host.begin();
    t = 0;
    limit = end;
    status = 'playing';
    show();
    publish(true);
  }

  function finish() {
    status = 'done';
    host.end('walk', last ?? undefined);
    publish(true);
  }

  const tour: Tour = {
    play() {
      if (status === 'playing') return;
      if (status === 'paused') {
        status = 'playing';
        limit = Infinity;
        publish(true);
        return;
      }
      start(Infinity);
    },
    pause() {
      if (status !== 'playing') return;
      status = 'paused';
      publish(true);
    },
    stop() {
      if (status === 'idle') return;
      const was = status;
      status = 'idle';
      t = 0;
      last = null;
      if (was !== 'done') host.end('restore');
      publish(true);
    },
    seek(seconds) {
      if (status === 'idle' || status === 'done') {
        path = null;
        host.begin();
        status = 'paused';
      }
      t = Math.min(getPath().duration, Math.max(0, seconds));
      limit = Infinity;
      show();
      publish(true);
    },
    reveal() {
      start(0);
      limit = getPath().revealEnd;
      if (limit <= 0) {
        t = 0;
        show();
        finish();
      }
    },
    get duration() {
      return getPath().duration;
    },
  };

  const interrupt = () => tour.pause();
  host.element.addEventListener('pointerdown', interrupt, { signal: host.signal });
  host.element.addEventListener('wheel', interrupt, { signal: host.signal, passive: true });
  host.element.addEventListener('touchstart', interrupt, { signal: host.signal, passive: true });
  addEventListener('keydown', (e) => {
    if (MOVE_KEYS.has(e.code) && !(e.target as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable]')) interrupt();
  }, { signal: host.signal });

  return {
    tour,
    get active() {
      return status === 'playing' || status === 'paused';
    },
    tick(dt, a) {
      const resized = a !== aspect;
      aspect = a;
      if (status === 'paused') {
        if (resized) show();
        return;
      }
      if (status !== 'playing') return;
      t = Math.min(t + dt, getPath().duration, limit);
      show();
      if (t >= Math.min(limit, getPath().duration)) finish();
      else publish();
    },
    release() {
      if (status === 'idle') return;
      status = 'idle';
      t = 0;
      last = null;
      publish(true);
    },
  };
}
