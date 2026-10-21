import * as THREE from 'three/webgpu';
import type { BuiltHouse, HouseEditor } from '../build/house.ts';
import { isFixture, pieceFinishes } from '../build/furniture.ts';
import { applyEdits, type PlanEdits } from '../plan/edits.ts';
import { FURNITURE_DEFAULT_SIZE } from '../plan/furnitureSizes.ts';
import { roomAt } from '../plan/geom.ts';
import { levelOf, levelPlan } from '../plan/levels.ts';
import { placementProblem, snapPlacement, TURN_STEP, type PlacementProblem } from '../plan/placement.ts';
import type { Furniture, Plan, Vec2 } from '../plan/schema.ts';
import { surfaceFinish, surfaceId } from '../plan/surfaces.ts';
import { Carry, PlacementMarker } from './handling.ts';

/** Hand editing in a viewer made `editable`: pieces move by drag, and surfaces take new finishes. */
export interface ViewerEditor {
  /** Shows the plan as loaded with these edits laid over it, which may hold saved ones again. */
  setEdits(edits: PlanEdits): Promise<void>;
  /** The plan with the edits on show. */
  plan(): Plan;
  /** Hears when a piece is selected, and when a held piece is let go where it can stand. */
  listen(events: EditorEvents | null): void;
  select(id: string | null): void;
  /** Stairs, roofs and fixtures stay where the agent put them; they can only be painted. */
  locked(id: string): boolean;
  /** Turns a piece where it stands. False, and nothing changes, when it would run into something. */
  turn(id: string, degrees: number): boolean;
  /** The floor under a screen point, on the storey on show. */
  floorAt(clientX: number, clientY: number): { position: Vec2; level?: string; room?: string } | null;
  /** The nearest free spot to `near` where a piece fits, snapped, or null when there is none within a metre and a half. */
  fit(piece: Furniture, near: Vec2): Vec2 | null;
  /** The surface someone can paint under a screen point, and the finish it has. */
  surfaceAt(clientX: number, clientY: number): { surface: string; finish?: string } | null;
  /** Every surface drawn with a finish, for painting them all at once. */
  surfacesWith(finish: string): string[];
  /** Library models and texture sets someone can place and paint with. */
  catalog(): EditorCatalog;
}

export interface EditorCatalog {
  /** `path` is what a piece's `model` names, such as `@lib/models/armchair_01.glb`; size is [width, depth, height]. */
  models: { id: string; path: string; size: [number, number, number] }[];
  /** `size` is the metres one repeat covers; `swatch` a small colour image. */
  textures: { id: string; size: [number, number]; swatch?: string }[];
}

export interface EditorEvents {
  onSelect(id: string | null): void;
  onPlace(id: string, position: Vec2, rotation: number): void;
}

/** What the viewer lends the editor. */
export interface EditorHost {
  house: BuiltHouse & { editor: HouseEditor };
  /** The plan as loaded. */
  plan: Plan;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera(): THREE.Camera;
  /** Editing is possible now: plan or dollhouse, with no tour, look-around or picking under way. */
  allowed(): boolean;
  /** Floor height of the storey on show. */
  floorHeight(): number;
  designOption(): string | null;
  /** First shown mesh under a screen point among `targets`, below the cut. */
  aim(clientX: number, clientY: number, targets: THREE.Object3D[]): THREE.Intersection | undefined;
  /** Ends any camera drag in progress and keeps the camera still while a piece is held. */
  holdCamera(held: boolean): void;
  changed(): void;
  report(patch: { selected?: string | null; blocked?: PlacementProblem | null }): void;
  catalog: EditorCatalog;
  signal: AbortSignal;
}

const SELECTED = '#2f6fd6', BLOCKED = '#d6453d', FIXED = '#8a8a86';
/** A press that moves this many pixels picks a piece up rather than clicking it. */
const DRAG_START = 4;

export function createEditor(host: EditorHost): ViewerEditor {
  const { house, canvas, signal } = host;
  const pieces = house.editor.pieces;
  let edited = host.plan;
  let events: EditorEvents | null = null;
  let selected: string | null = null;
  let queue = Promise.resolve();

  const marker = new PlacementMarker();
  host.scene.add(marker.group);
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The piece in someone's hand, or dropping back onto the floor. */
  let carry: Carry | null = null;
  let frame = 0;
  function animate() {
    if (frame) return;
    let last = performance.now();
    const tick = (now: number) => {
      const moving = carry?.step((now - last) / 1000) ?? false;
      last = now;
      host.changed();
      if (moving) frame = requestAnimationFrame(tick);
      else {
        frame = 0;
        if (!carry?.lifted) carry = null;
      }
    };
    frame = requestAnimationFrame(tick);
  }
  signal.addEventListener('abort', () => {
    if (frame) cancelAnimationFrame(frame);
    marker.dispose();
  });

  const pieceOf = (id: string) => edited.furniture?.find((f) => f.id === id);
  const locked = (id: string) => {
    const f = pieceOf(id);
    return !f || f.type === 'stairs' || !!f.roof || isFixture(f);
  };

  /** A piece's [width, depth, height] and how high its base stands, as drawn. */
  function measure(obj: THREE.Object3D) {
    if (!obj.userData.measured) {
      const turn = obj.rotation.y;
      obj.rotation.y = 0;
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      obj.rotation.y = turn;
      obj.updateMatrixWorld(true);
      const s = box.getSize(new THREE.Vector3());
      const floor = levelOf(edited, obj.userData.piece?.level).elevation;
      obj.userData.measured = { size: [s.x, s.z, s.y], base: box.min.y - floor };
    }
    return obj.userData.measured as { size: [number, number, number]; base: number };
  }
  const sizeOf = (f: Furniture) => {
    const obj = pieces.get(f.id);
    return obj ? measure(obj).size : (f.size ?? FURNITURE_DEFAULT_SIZE[f.type]);
  };
  const storeyOf = (f: Furniture) => levelPlan(edited, levelOf(edited, f.level));
  const problemAt = (f: Furniture, position: Vec2, rotation: number, size = sizeOf(f), base?: number) =>
    placementProblem(storeyOf(f), { id: f.id, type: f.type, position, rotation, size, elevation: base ?? (pieces.get(f.id) ? measure(pieces.get(f.id)!).base : f.elevation) }, sizeOf, host.designOption());

  function pose(obj: THREE.Object3D, position: Vec2, rotation: number) {
    obj.position.x = position[0];
    obj.position.z = position[1];
    obj.rotation.y = -THREE.MathUtils.degToRad(rotation);
    obj.updateMatrixWorld(true);
  }

  /** Marks the selected piece on its floor: where a held one would land, and the way it would face. */
  function showOutline(blocked = false) {
    const obj = selected ? pieces.get(selected) : undefined;
    const f = selected ? pieceOf(selected) : undefined;
    if (!obj || !f) marker.hide();
    else {
      const [x, z, rotation] = press?.held && press.id === selected ? [...press.at, press.rotation] : [...f.position, f.rotation ?? 0];
      marker.show(measure(obj).size, x, levelOf(edited, f.level).elevation, z, -THREE.MathUtils.degToRad(rotation), blocked ? BLOCKED : locked(selected!) ? FIXED : SELECTED);
    }
    host.changed();
  }

  function select(id: string | null) {
    if (id === selected) return;
    selected = id && pieces.has(id) ? id : null;
    showOutline();
    host.report({ selected });
    events?.onSelect(selected);
  }

  /** The piece under a screen point, if one shows there. */
  function pieceAt(clientX: number, clientY: number) {
    let o: THREE.Object3D | null = host.aim(clientX, clientY, [house.furniture, house.roofs])?.object ?? null;
    for (; o; o = o.parent) if (o.userData.kind === 'furniture' && pieces.get(o.userData.id) === o) return o.userData.id as string;
    return null;
  }

  const ray = new THREE.Raycaster();
  /** Where a screen point meets the horizontal plane at height `y`, in plan coordinates. */
  function onFloor(clientX: number, clientY: number, y: number): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), host.camera());
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
    return hit ? [hit.x, hit.z] : null;
  }

  // ---------- holding a piece ----------

  let press: { id: string; x: number; y: number; grab: Vec2; from: Vec2; turn: number; at: Vec2; rotation: number; problem: PlacementProblem | null; held: boolean } | null = null;

  /** Where the last press began, and whether its click ends a drag of a piece. */
  let down: { x: number; y: number } | null = null;
  let dragged = false;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
    dragged = false;
    if (e.button !== 0 || e.pointerType !== 'mouse' || e.shiftKey || e.metaKey || e.ctrlKey || !host.allowed()) return;
    const id = pieceAt(e.clientX, e.clientY);
    if (!id) return;
    // The camera does not move under a press on a piece.
    e.stopImmediatePropagation();
    host.holdCamera(true);
    select(id);
    const f = pieceOf(id)!;
    const floor = onFloor(e.clientX, e.clientY, levelOf(edited, f.level).elevation);
    if (locked(id) || !floor) {
      press = null;
      return;
    }
    const rotation = f.rotation ?? 0;
    press = { id, x: e.clientX, y: e.clientY, grab: [f.position[0] - floor[0], f.position[1] - floor[1]], from: f.position, turn: rotation, at: f.position, rotation, problem: null, held: false };
  }, { capture: true, signal });

  function follow(clientX: number, clientY: number, free: boolean) {
    if (!press) return;
    const f = pieceOf(press.id), obj = pieces.get(press.id);
    if (!f || !obj) return;
    const floor = onFloor(clientX, clientY, levelOf(edited, f.level).elevation);
    if (!floor) return;
    const raw: Vec2 = [floor[0] + press.grab[0], floor[1] + press.grab[1]];
    const { size } = measure(obj);
    press.at = free ? raw : snapPlacement(storeyOf(f), raw, press.rotation, size);
    press.problem = problemAt(f, press.at, press.rotation);
    if (carry?.obj === obj) carry.target = { x: press.at[0], z: press.at[1], yaw: -THREE.MathUtils.degToRad(press.rotation) };
    else pose(obj, press.at, press.rotation);
    animate();
    showOutline(!!press.problem);
    host.report({ blocked: press.problem });
  }

  document.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (!press.held && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_START) return;
    if (!press.held) {
      const obj = pieces.get(press.id);
      if (obj) {
        carry?.rest();
        carry = new Carry(obj, reducedMotion);
      }
    }
    press.held = true;
    canvas.style.cursor = 'grabbing';
    follow(e.clientX, e.clientY, e.altKey);
  }, { signal });

  function letGo(cancel: boolean) {
    const p = press;
    press = null;
    host.holdCamera(false);
    if (!p) return;
    host.report({ blocked: null });
    const obj = pieces.get(p.id);
    if (!p.held || !obj) return;
    dragged = true;
    const moved = p.at[0] !== p.from[0] || p.at[1] !== p.from[1] || p.rotation !== p.turn;
    if (carry?.obj === obj) {
      // It drops where it was let go, or floats home first when it cannot stand there.
      carry.lifted = false;
      if (cancel || p.problem || !moved) carry.target = { x: p.from[0], z: p.from[1], yaw: -THREE.MathUtils.degToRad(p.turn) };
      animate();
    }
    if (cancel || p.problem || !moved) {
      if (carry?.obj !== obj) pose(obj, p.from, p.turn);
      showOutline();
      return;
    }
    showOutline();
    events?.onPlace(p.id, p.at, p.rotation);
  }
  document.addEventListener('pointerup', (e) => {
    if (e.button === 0) letGo(false);
  }, { signal });
  addEventListener('blur', () => letGo(true), { signal });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && press) {
      e.preventDefault();
      letGo(true);
    }
  }, { signal });

  // The wheel turns a held piece instead of zooming.
  canvas.addEventListener('wheel', (e) => {
    if (!press?.held) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    press.rotation = (((press.rotation + Math.sign(e.deltaY) * TURN_STEP) % 360) + 360) % 360;
    const last = { x: press.x, y: press.y };
    follow(e.clientX ?? last.x, e.clientY ?? last.y, e.altKey);
  }, { capture: true, passive: false, signal });

  // A click on nothing movable clears the selection; a drag only turns the camera. The click that
  // ends a drag of a piece is the editor's, so it never opens a door under the piece.
  canvas.addEventListener('click', (e) => {
    if (dragged) {
      dragged = false;
      e.stopImmediatePropagation();
      return;
    }
    if (!host.allowed() || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_START) return;
    if (!pieceAt(e.clientX, e.clientY)) select(null);
  }, { capture: true, signal });

  let hoverAt = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (press || e.buttons || !host.allowed() || e.timeStamp - hoverAt < 60) return;
    hoverAt = e.timeStamp;
    const id = pieceAt(e.clientX, e.clientY);
    if (id) canvas.style.cursor = locked(id) ? 'pointer' : 'grab';
  }, { signal });

  // ---------- edits ----------

  /** A piece's plan entry without where it stands: when this differs, it is built again. */
  const look = ({ position: _p, rotation: _r, ...rest }: Furniture) => JSON.stringify(rest);

  async function show(edits: PlanEdits) {
    edited = applyEdits(host.plan, edits).plan;
    house.editor.repaint(edited);
    const wanted = new Map((edited.furniture ?? []).map((f) => [f.id, f]));
    for (const id of [...pieces.keys()]) if (!wanted.has(id)) house.editor.remove(id);
    await Promise.all([...wanted.values()].map(async (f) => {
      const obj = pieces.get(f.id);
      const current = obj && look(obj.userData.piece) === look(f) ? obj : await house.editor.build(f);
      current.userData.piece = f;
      // A piece still settling lands on its own.
      if (carry?.obj === current) carry.target = { x: f.position[0], z: f.position[1], yaw: -THREE.MathUtils.degToRad(f.rotation ?? 0) };
      else pose(current, f.position, f.rotation ?? 0);
    }));
    if (selected && !pieces.has(selected)) select(null);
    else showOutline();
  }

  return {
    setEdits(edits) {
      queue = queue.then(() => show(edits));
      return queue;
    },
    plan: () => edited,
    listen(next) {
      events = next;
    },
    select,
    locked,
    turn(id, degrees) {
      const f = pieceOf(id);
      if (!f || locked(id)) return false;
      const rotation = ((((f.rotation ?? 0) + degrees) % 360) + 360) % 360;
      if (problemAt(f, f.position, rotation)) {
        showOutline(true);
        setTimeout(() => showOutline(), 450);
        return false;
      }
      events?.onPlace(id, f.position, rotation);
      return true;
    },
    floorAt(clientX, clientY) {
      const y = host.floorHeight();
      const position = onFloor(clientX, clientY, y);
      if (!position) return null;
      const level = edited.levels?.length ? [...edited.levels].reverse().find((l) => l.elevation <= y + 0.01) : undefined;
      const room = roomAt(level ? levelPlan(edited, level) : edited, position);
      return { position, ...(level && { level: level.id }), ...(room && { room: room.id }) };
    },
    fit(piece, near) {
      const storey = storeyOf(piece);
      const size = piece.size ?? FURNITURE_DEFAULT_SIZE[piece.type];
      const rotation = piece.rotation ?? 0;
      // Rings of candidate spots 10 cm apart, nearest first.
      for (let r = 0; r <= 15; r++) {
        const ring = r === 0 ? [[0, 0]] : Array.from({ length: 8 * r }, (_, i) => {
          const a = (i / (8 * r)) * Math.PI * 2;
          return [Math.cos(a) * r * 0.1, Math.sin(a) * r * 0.1];
        });
        for (const [dx, dy] of ring) {
          const at = snapPlacement(storey, [near[0] + dx, near[1] + dy], rotation, size);
          if (!problemAt(piece, at, rotation, size, piece.elevation ?? 0)) return at;
        }
      }
      return null;
    },
    surfaceAt(clientX, clientY) {
      const hit = host.aim(clientX, clientY, [house.walls, house.floors, house.furniture]);
      if (!hit) return null;
      let o: THREE.Object3D | null = hit.object;
      for (; o; o = o.parent) {
        if (o.userData.kind === 'furniture' && pieces.get(o.userData.id) === o) {
          const f = pieceOf(o.userData.id);
          // Models carry their own materials.
          if (!f || f.model) return null;
          const [main, accent] = pieceFinishes(f);
          const mesh = hit.object as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const name = mats[hit.face?.materialIndex ?? 0]?.name ?? mats[0]?.name;
          const slot = name === accent && name !== main ? 'accent' : 'material';
          return { surface: surfaceId({ kind: 'furniture', piece: f.id, slot }), finish: slot === 'accent' ? accent : main };
        }
      }
      const surfaces = hit.object.userData.surfaces as (string | null)[] | undefined;
      const surface = surfaces ? surfaces[hit.face?.materialIndex ?? -1] : (hit.object.userData.surface as string | undefined);
      return surface ? { surface, finish: surfaceFinish(edited, surface) } : null;
    },
    catalog: () => host.catalog,
    surfacesWith(finish) {
      const out = new Set<string>();
      for (const g of [house.walls, house.floors]) g.traverse((o) => {
        for (const s of [o.userData.surface, ...(o.userData.surfaces ?? [])] as (string | null | undefined)[])
          if (s && surfaceFinish(edited, s) === finish) out.add(s);
      });
      for (const f of edited.furniture ?? []) {
        if (f.model || f.roof) continue;
        const [main, accent] = pieceFinishes(f);
        if (main === finish) out.add(surfaceId({ kind: 'furniture', piece: f.id, slot: 'material' }));
        if (accent === finish && accent !== main) out.add(surfaceId({ kind: 'furniture', piece: f.id, slot: 'accent' }));
      }
      return [...out];
    },
  };
}
