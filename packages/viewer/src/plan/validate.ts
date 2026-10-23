import type { Plan, Vec2 } from './schema.ts';
import { withDefaults } from './schema.ts';
import {
  EPS, dist, planBounds, pointInPolygon, pointSegment, polygonArea, polygonSelfIntersects, roomNetArea,
  wallHeight, wallLength, wallThickness, wallDir, cross, sub, dot, ceilingAt, hasCeiling,
} from './geom.ts';
import { FURNITURE_DEFAULT_SIZE } from './furnitureSizes.ts';
import { levelPlan, levels, stairFlights } from './levels.ts';

export interface Issue {
  level: 'error' | 'warn';
  where: string;
  message: string;
}

const isVec2 = (v: unknown): v is Vec2 =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isLength = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * Checks a plan for mistakes. Errors are what breaks the build or the plan's integrity: bad numbers,
 * degenerate shapes, openings that don't fit, broken references. Warnings are building heuristics that
 * betray a misread plan: dangling walls, room areas that disagree with the printed labels, furniture
 * outside its room. A plan without walls (a plaza, a landscape) is valid.
 */
export function validatePlan(plan: Plan): Issue[] {
  const issues: Issue[] = [];
  const err = (where: string, message: string) => issues.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => issues.push({ level: 'warn', where, message });
  const d = withDefaults(plan);
  const ids = new Map<string, string>();
  const claim = (id: string, kind: string) => {
    if (!id) err(kind, 'missing id');
    else if (ids.has(id)) err(`${kind} ${id}`, `id already used by a ${ids.get(id)}`);
    else ids.set(id, kind);
  };

  if (plan.version !== 1) err('plan', `version must be 1, got ${String(plan.version)}`);
  if (!Array.isArray(plan.walls)) {
    err('plan', 'walls must be an array, empty for a plan without walls');
    return issues;
  }
  if (plan.north !== undefined && !isNumber(plan.north)) err('plan', 'north must be degrees clockwise from the top of the plan');
  if (plan.latitude !== undefined && !(isNumber(plan.latitude) && Math.abs(plan.latitude) <= 90)) err('plan', 'latitude must be degrees from -90 to 90');

  if (plan.levels !== undefined && !checkLevels(plan, err, warn, claim)) return issues;
  checkDesignOptions(plan, err, claim);
  checkLevelReferences(plan, err);
  for (const level of levels(plan)) {
    const storey = levelPlan(plan, level);
    // A storey without walls is a terrace or a site level; in a building it is usually a slip.
    if (plan.levels?.length && plan.walls.length && !storey.walls.length) warn(`level ${level.id}`, 'has no walls');
    checkStorey(storey, err, warn, claim);
  }

  // Overall size against the printed dimensions
  if (plan.source?.overall && plan.walls.length) {
    const b = planBounds(plan);
    // Bounds use centerlines; the printed overall size is to the outside faces.
    const t = d.exteriorThickness;
    const [ow, oh] = plan.source.overall;
    const dw = b.w + t - ow;
    const dh = b.h + t - oh;
    if (Math.abs(dw) > 0.1 || Math.abs(dh) > 0.1)
      warn('plan', `outside size ${(b.w + t).toFixed(2)} × ${(b.h + t).toFixed(2)} m vs printed ${ow} × ${oh} m`);
  }

  return issues;
}

type Report = (where: string, message: string) => void;

/** Storeys must be named, stacked at least 2 m apart, and every `level` must name one of them. */
function checkLevels(plan: Plan, err: Report, warn: Report, claim: (id: string, kind: string) => void) {
  if (!Array.isArray(plan.levels) || !plan.levels.every((l) => l && typeof l === 'object')) {
    err('plan', 'levels must be an array of { id, name, elevation }');
    return false;
  }
  let valid = true;
  for (const l of plan.levels) {
    claim(l.id, 'level');
    if (typeof l.name !== 'string' || !l.name.trim()) err(`level ${l.id}`, 'needs a name');
    if (typeof l.elevation !== 'number' || !Number.isFinite(l.elevation)) {
      err(`level ${l.id}`, 'elevation must be a number of meters');
      valid = false;
    }
    if (l.height !== undefined && !(typeof l.height === 'number' && l.height > 0)) err(`level ${l.id}`, 'height must be a positive number of meters');
  }
  if (!valid) return false;
  const stacked = levels(plan);
  for (let i = 1; i < stacked.length; i++) {
    const below = stacked[i - 1], above = stacked[i];
    const gap = above.elevation - below.elevation;
    // Head room is a rule for the walls of a building; terraces of a site may step by any height.
    if (!levelPlan(plan, below).walls.length) continue;
    if (gap < 2) warn(`level ${above.id}`, `sits ${gap.toFixed(2)} m above level ${below.id}; storeys of a building need at least 2 m`);
    else if ((below.height ?? withDefaults(plan).wallHeight) > gap + 0.01)
      warn(`level ${below.id}`, `walls of ${below.height ?? withDefaults(plan).wallHeight} m reach through the ${gap.toFixed(2)} m storey into level ${above.id}`);
  }
  if (stacked.length > 1)
    for (const flight of stairFlights(plan)) {
      // A run may end on a half landing where the next run starts.
      const landing = stairFlights(plan).some((next) => next !== flight && Math.abs(next.base - flight.top) <= 0.05);
      if (!landing && !stacked.some((l) => l.elevation > flight.base && Math.abs(l.elevation - flight.top) <= 0.05))
        warn(`furniture ${flight.id}`, `stairs climb to ${flight.top.toFixed(2)} m, but no storey has its floor there`);
      const rooms = levelPlan(plan, flight.level).rooms ?? [];
      if (!rooms.some((r) => flight.footprint.every((p) => pointInPolygon(p, r.polygon))))
        warn(`furniture ${flight.id}`, 'stairs are not inside one room, so no opening is cut in the ceiling above them');
    }
  return true;
}

/** Design options are named, at most one is the default, and furniture names only real ones. */
function checkDesignOptions(plan: Plan, err: Report, claim: (id: string, kind: string) => void) {
  const options = plan.designOptions;
  if (options !== undefined) {
    if (!Array.isArray(options) || !options.every((o) => o && typeof o === 'object')) {
      err('plan', 'designOptions must be an array of { id, name, materials? }');
      return;
    }
    for (const o of options) {
      claim(o.id, 'design option');
      if (typeof o.name !== 'string' || !o.name.trim()) err(`design option ${o.id}`, 'needs a name');
      if (o.default !== undefined && typeof o.default !== 'boolean') err(`design option ${o.id}`, 'default must be a boolean');
      if (o.materials !== undefined) {
        if (!o.materials || typeof o.materials !== 'object' || Array.isArray(o.materials)) err(`design option ${o.id}`, 'materials must map material keys to materials');
        else for (const [key, m] of Object.entries(o.materials))
          if (!m || typeof m !== 'object' || typeof m.color !== 'string') err(`design option ${o.id}`, `material "${key}" needs a color`);
      }
    }
    if (options.filter((o) => o.default === true).length > 1) err('plan', 'only one design option can be the default');
  }
  const known = new Set((options ?? []).map((o) => o.id));
  for (const f of plan.furniture ?? []) {
    if (f.designOptions === undefined) continue;
    if (!Array.isArray(f.designOptions) || !f.designOptions.length) err(`furniture ${f.id}`, 'designOptions must list at least one design option');
    else for (const id of f.designOptions) if (!known.has(id)) err(`furniture ${f.id}`, `design option "${id}" does not exist`);
  }
}

/** Every `level` an element names must be a storey of the plan. */
function checkLevelReferences(plan: Plan, err: Report) {
  const known = new Set((plan.levels ?? []).map((l) => l.id));
  const elements = [
    ['wall', plan.walls], ['room', plan.rooms ?? []], ['furniture', plan.furniture ?? []], ['camera', plan.cameras ?? []],
  ] as const;
  for (const [kind, list] of elements)
    for (const e of list as { id: string; level?: string }[])
      if (e.level !== undefined && !known.has(e.level)) err(`${kind} ${e.id}`, `level "${e.level}" does not exist`);
}

/** Checks within one storey: walls, openings, rooms, furniture and cameras on the same floor. */
function checkStorey(plan: Plan, err: Report, warn: Report, claim: (id: string, kind: string) => void) {
  const d = withDefaults(plan);

  // Walls
  for (const w of plan.walls) {
    claim(w.id, 'wall');
    if (!isVec2(w.a) || !isVec2(w.b)) {
      err(`wall ${w.id}`, 'a and b must be [x, y] number pairs');
      continue;
    }
    const L = wallLength(w);
    if (L < 0.05) err(`wall ${w.id}`, `is ${L.toFixed(3)} m long`);
    if (w.thickness !== undefined && !isLength(w.thickness)) err(`wall ${w.id}`, 'thickness must be a positive number of meters');
    if (w.height !== undefined && !isLength(w.height)) err(`wall ${w.id}`, 'height must be a positive number of meters');
    if (w.outsideFinish !== undefined && typeof w.outsideFinish !== 'string') err(`wall ${w.id}`, 'outsideFinish must be a material key or colour');
    const t = wallThickness(plan, w);
    if (t < 0.05 || t > 0.8) warn(`wall ${w.id}`, `thickness ${t} m looks wrong (expected 0.08 to 0.5)`);
    const ang = (Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]) * 180) / Math.PI;
    const off = Math.abs(((ang % 90) + 90) % 90);
    if (off > 0.3 && off < 89.7 && Math.min(off, 90 - off) < 3)
      warn(`wall ${w.id}`, `is ${Math.min(off, 90 - off).toFixed(1)}° off axis. Probably a tracing error; snap it.`);
    for (const [end, p] of [['a', w.a], ['b', w.b]] as const) {
      const touches = plan.walls.some((o) => o !== w && pointSegment(p, o.a, o.b).d < EPS);
      if (!touches) warn(`wall ${w.id}`, `end ${end} [${p.join(', ')}] connects to no other wall`);
    }
  }

  // Overlapping collinear walls draw twice and z-fight.
  for (let i = 0; i < plan.walls.length; i++) {
    for (let j = i + 1; j < plan.walls.length; j++) {
      const A = plan.walls[i], B = plan.walls[j];
      const dA = wallDir(A);
      if (Math.abs(cross(dA, wallDir(B))) > 0.01) continue; // not parallel
      if (Math.abs(cross(sub(B.a, A.a), dA)) > EPS) continue; // parallel but on another line
      const ta = [dot(sub(B.a, A.a), dA), dot(sub(B.b, A.a), dA)].sort((x, y) => x - y);
      const overlap = Math.min(ta[1], wallLength(A)) - Math.max(ta[0], 0);
      if (overlap > EPS) err(`wall ${A.id} / ${B.id}`, `overlap by ${overlap.toFixed(2)} m along the same line`);
    }
  }

  // Openings
  const byWall = new Map<string, { id: string; s: number; e: number }[]>();
  for (const o of plan.openings ?? []) {
    claim(o.id, 'opening');
    const w = plan.walls.find((x) => x.id === o.wall);
    if (!w) {
      err(`opening ${o.id}`, `wall "${o.wall}" does not exist`);
      continue;
    }
    if (!isNumber(o.offset) || !isLength(o.width) || (o.height !== undefined && !isLength(o.height)) || (o.sill !== undefined && !isNumber(o.sill))) {
      err(`opening ${o.id}`, 'offset, width, height and sill must be numbers of meters, width and height above 0');
      continue;
    }
    const L = wallLength(w);
    const s = o.offset - o.width / 2;
    const e = o.offset + o.width / 2;
    if (o.width <= 0.2) warn(`opening ${o.id}`, `width ${o.width} m is very small`);
    if (s < 0.05 || e > L - 0.05)
      err(`opening ${o.id}`, `spans ${s.toFixed(2)} to ${e.toFixed(2)} m but wall ${w.id} is ${L.toFixed(2)} m long`);
    const isWindow = o.type === 'window';
    const sill = isWindow ? (o.sill ?? d.windowSill) : 0;
    const h = o.height ?? (isWindow ? d.windowHeight : o.type === 'garage-door' ? 2.2 : d.doorHeight);
    if (sill + h > wallHeight(plan, w) - 0.05)
      err(`opening ${o.id}`, `top at ${(sill + h).toFixed(2)} m reaches the ${wallHeight(plan, w)} m wall top`);
    if (o.type === 'door' && (o.width < 0.6 || o.width > 1.2)) warn(`opening ${o.id}`, `door width ${o.width} m is unusual`);
    const list = byWall.get(w.id) ?? [];
    for (const other of list)
      if (s < other.e - 0.02 && e > other.s + 0.02) err(`opening ${o.id}`, `overlaps opening ${other.id} on wall ${w.id}`);
    list.push({ id: o.id, s, e });
    byWall.set(w.id, list);
  }

  // Rooms
  for (const r of plan.rooms ?? []) {
    claim(r.id, 'room');
    if (!Array.isArray(r.polygon) || r.polygon.length < 3 || !r.polygon.every(isVec2)) {
      err(`room ${r.id}`, 'polygon needs at least 3 [x, y] points');
      continue;
    }
    if (dist(r.polygon[0], r.polygon[r.polygon.length - 1]) < EPS)
      warn(`room ${r.id}`, 'last point repeats the first; drop it');
    if (polygonSelfIntersects(r.polygon)) err(`room ${r.id}`, 'polygon crosses itself');
    if (polygonArea(r.polygon) < 1e-4) {
      err(`room ${r.id}`, 'polygon encloses no area');
      continue;
    }
    if (r.ceiling !== undefined && r.ceiling !== false && typeof r.ceiling !== 'string') err(`room ${r.id}`, 'ceiling must be a material key or colour, or false for no ceiling');
    if (r.ceilingHeight !== undefined && !isLength(r.ceilingHeight)) err(`room ${r.id}`, 'ceilingHeight must be a positive number of meters');
    const area = roomNetArea(plan, r.polygon);
    if (area < 1 && plan.walls.length) warn(`room ${r.id}`, `net area is only ${area.toFixed(2)} m²`);
    if (r.wallFinishes !== undefined) {
      if (!r.wallFinishes || typeof r.wallFinishes !== 'object') err(`room ${r.id}`, 'wallFinishes must map wall ids to material keys');
      else
        for (const [wall, key] of Object.entries(r.wallFinishes)) {
          if (typeof key !== 'string') err(`room ${r.id}`, `wallFinishes.${wall} must be a material key or colour`);
          else if (!plan.walls.some((w) => w.id === wall)) warn(`room ${r.id}`, `wallFinishes names wall "${wall}", which is not on this floor`);
        }
    }
    const slope = r.ceilingSlope;
    if (slope !== undefined) {
      if (!slope || typeof slope !== 'object' || typeof slope.rise !== 'number' || !Number.isFinite(slope.rise) || slope.rise < 0)
        err(`room ${r.id}`, 'ceilingSlope.rise must be metres of rise per metre of run, 0 or more');
      else if (typeof slope.toward !== 'number' || !Number.isFinite(slope.toward))
        err(`room ${r.id}`, 'ceilingSlope.toward must be degrees clockwise from the top of the plan');
      else if (slope.from !== undefined && !isVec2(slope.from)) err(`room ${r.id}`, 'ceilingSlope.from must be [x, y]');
      else if (hasCeiling(plan, r)) {
        if (slope.rise > 1) warn(`room ${r.id}`, `ceiling pitch of ${(slope.rise * 100).toFixed(0)}% is steeper than 45°`);
        const low = Math.min(...r.polygon.map((p) => ceilingAt(plan, r, p)));
        if (low < 1.8) warn(`room ${r.id}`, `sloped ceiling comes down to ${low.toFixed(2)} m`);
      }
    }
    if (r.areaLabel) {
      const diff = (area - r.areaLabel) / r.areaLabel;
      if (Math.abs(diff) > 0.08)
        warn(`room ${r.id}`, `area ${area.toFixed(2)} m² vs ${r.areaLabel} m² on the plan (${(diff * 100).toFixed(0)}%). Check the scale or the polygon.`);
    }
  }

  // Furniture
  for (const f of plan.furniture ?? []) {
    claim(f.id, 'furniture');
    if (f.fixture !== undefined && typeof f.fixture !== 'boolean') err(`furniture ${f.id}`, 'fixture must be a boolean');
    if (f.roof !== undefined && typeof f.roof !== 'boolean') err(`furniture ${f.id}`, 'roof must be a boolean');
    if (f.ground !== undefined && typeof f.ground !== 'boolean') err(`furniture ${f.id}`, 'ground must be a boolean');
    if (!isVec2(f.position)) {
      err(`furniture ${f.id}`, 'position must be [x, y]');
      continue;
    }
    if (f.size !== undefined && !(Array.isArray(f.size) && f.size.length === 3 && f.size.every(isLength)))
      err(`furniture ${f.id}`, 'size must be [width, depth, height], each a positive number of meters');
    if (f.rotation !== undefined && !isNumber(f.rotation)) err(`furniture ${f.id}`, 'rotation must be a number of degrees');
    if (f.elevation !== undefined && !isNumber(f.elevation)) err(`furniture ${f.id}`, 'elevation must be a number of meters');
    if (!(f.type in FURNITURE_DEFAULT_SIZE))
      warn(`furniture ${f.id}`, `unknown type "${f.type}"; it is drawn ${f.model ? 'from its model' : 'as a box'}`);
    if (f.room) {
      const room = plan.rooms?.find((r) => r.id === f.room);
      if (!room) err(`furniture ${f.id}`, `room "${f.room}" does not exist`);
      else if (!f.ground && !pointInPolygon(f.position, room.polygon)) warn(`furniture ${f.id}`, `center is outside room ${room.id}`);
    }
    // Ground spans the site; its centre says nothing about the walls.
    if (f.type === 'rug' || f.type === 'stairs' || f.ground) continue;
    const [fw, fd] = f.size ?? FURNITURE_DEFAULT_SIZE[f.type] ?? [0.5, 0.5, 0.5];
    const r = Math.min(fw, fd) / 2;
    for (const w of plan.walls) {
      const { d: dd } = pointSegment(f.position, w.a, w.b);
      if (dd + 0.01 < r * 0.6 + wallThickness(plan, w) / 2) {
        warn(`furniture ${f.id}`, `sits inside wall ${w.id}`);
        break;
      }
    }
  }

  // Cameras
  for (const c of plan.cameras ?? []) {
    claim(c.id, 'camera');
    if (!isVec2(c.position) || !isVec2(c.lookAt)) err(`camera ${c.id}`, 'position and lookAt must be [x, y]');
    else if (dist(c.position, c.lookAt) < 0.1) err(`camera ${c.id}`, 'lookAt is on top of position');
  }
}

export function summarize(plan: Plan) {
  const b = planBounds(plan);
  const rooms = plan.rooms ?? [];
  const area = rooms.reduce((s, r) => s + roomNetArea(plan, r.polygon), 0);
  return {
    walls: plan.walls.length,
    openings: plan.openings?.length ?? 0,
    rooms: rooms.length,
    furniture: plan.furniture?.length ?? 0,
    cameras: plan.cameras?.length ?? 0,
    footprint: `${b.w.toFixed(2)} × ${b.h.toFixed(2)} m`,
    roomArea: `${area.toFixed(1)} m²`,
  };
}
