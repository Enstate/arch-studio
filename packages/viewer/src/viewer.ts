import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Plan } from './plan/schema.ts';
import { withDefaults } from './plan/schema.ts';
import { wallDir, wallThickness, pointInPolygon, roomAt } from './plan/geom.ts';
import { levelAt, levelOf, levelPlan } from './plan/levels.ts';
import { shownInOption } from './plan/options.ts';
import { MaterialLibrary } from './build/materials.ts';
import { buildHouse, CUT_HEIGHT, NO_CUT, type BuiltHouse, type BuiltLevel } from './build/house.ts';
import { Stage, sunElevation } from './viewer/stage.ts';
import { Walker } from './viewer/walk.ts';
import { FlyCamera } from './viewer/fly.ts';
import { bindOrbitInput, ORBIT_CURSOR } from './viewer/orbit-input.ts';
import { openingDoors, poseDoor, type Door } from './viewer/doors.ts';
import { PlanOverlay } from './viewer/overlay.ts';
import { Library, NON_FLOOR_MAX, type LibraryIndex } from './viewer/library.ts';
import { piecePicture } from './viewer/picture.ts';
import { capabilities } from './capabilities.ts';
import { takePrefetched } from './preload.ts';
import { buildTourPath, createTour, IDLE_TOUR, OUTSIDE, type Tour, type TourState } from './viewer/tour.ts';
import { createEditor, type EditorCatalog, type ViewerEditor } from './viewer/editor.ts';
import type { PlacementProblem } from './plan/placement.ts';

export type ViewerMode = 'plan' | 'dollhouse' | 'walk';
export type ViewerTheme = 'light' | 'dark';

export interface ViewerProgress {
  phase: 'renderer' | 'plan' | 'assets' | 'build' | 'compile' | 'first-frame' | 'ready';
  /** 0..1 over the whole load; 1 once the first frame shows every model and texture. */
  progress: number;
  /** Models and textures loaded so far, and requested so far. */
  loaded: number;
  total: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  /** Net floor area in m². */
  area: number;
  /** Plan coordinates in meters (x right, y down). */
  centroid: [number, number];
  /** Storey of the room, in a plan with several. */
  level?: string;
}

/** One look of a plan with design options. */
export interface DesignOptionInfo {
  id: string;
  name: string;
}

/** A storey of a plan with several. */
export interface LevelInfo {
  id: string;
  name: string;
  /** Floor height above the ground floor, in meters. */
  elevation: number;
}

export interface ViewerState {
  mode: ViewerMode;
  /** Time of day, 0..1 over 00:00..24:00. Light, lamps and sky follow it. */
  time: number;
  /** The sun is below the horizon. */
  night: boolean;
  cut: boolean;
  /** Loose furniture is shown; fixtures such as kitchens and baths always are. */
  furniture: boolean;
  /** The plan's own roofs show in the dollhouse; null when the plan supplies none. Walk mode always shows them. */
  roof: boolean | null;
  /** Design option on show; null for a plan without options. */
  designOption: string | null;
  grid: boolean;
  /** Room the camera is in (walk) or was last sent to (focusRoom). */
  room: string | null;
  /**
   * Storey on show: cut in plan, the top of the house in the dollhouse, the walker's floor in walk.
   * Null for a single-storey plan.
   */
  level: string | null;
  /** Walk mode has the mouse captured (pointer lock); Esc releases it. */
  locked: boolean;
  /** Every model and first-pass texture has loaded. */
  ready: boolean;
  tour: TourState;
  /** Opening IDs of doors that are closed or closing. */
  closedDoors: string[];
  /** Piece selected for hand editing; always null outside an editable viewer. */
  selected: string | null;
  /** What the piece held right now would run into where it is; it goes back if let go there. */
  blocked: PlacementProblem | null;
}

export type Vec3 = [number, number, number];

/** What a click hit while picking. */
export interface ViewerPick {
  /** World position in metres (y up). */
  point: Vec3;
  kind: 'furniture' | 'wall' | 'floor' | 'opening' | 'outside' | 'other';
  /** Plan type of the furniture or opening, such as `sofa` or `window`. */
  type?: string;
  /** Plan ID of the opening. */
  id?: string;
  room: { id: string; name: string } | null;
}

/** A camera to come back to: the mode and where the camera stands and looks. */
export interface ViewerView {
  mode: ViewerMode;
  position: Vec3;
  target: Vec3;
  /** Storey on show, in a plan with several. */
  level?: string;
  /** Design option on show, in a plan with options. */
  designOption?: string;
}

export interface ViewerStats {
  backend: 'webgpu' | 'webgl2';
  quality: 'full' | 'lite';
  /** From createViewer() to the first drawn frame. */
  firstFrameMs: number;
  /** Frames drawn over the last second; 0 while nothing moves, since a still view is not redrawn. */
  fps: number;
  /** Internal render resolution as a fraction of the canvas. */
  renderScale: number;
  /**
   * What the house on show asks of each frame, the same on any GPU: meshes drawn (about one draw call
   * each per pass), their triangles, distinct materials, how many of those use physical shading
   * (sheen, clearcoat, specular), and lamps casting shadows.
   */
  scene: { meshes: number; triangles: number; materials: number; physical: number; lampShadows: number };
}

export interface ViewerOptions {
  /** A parsed plan, or a URL to fetch it from. Plan-relative assets resolve against `planUrl`. */
  plan?: Plan;
  planUrl?: string;
  /** URL of the asset library folder (with index.json), e.g. "/viewer/library/". */
  assetBase: string;
  mode?: ViewerMode;
  /** Time of day, 0..1 over 00:00..24:00. Default 16:00. */
  time?: number;
  cut?: boolean;
  /** `auto` picks `lite` on phones and tablets. */
  quality?: 'auto' | 'full' | 'lite';
  /** Use the WebGL2 backend even where WebGPU is available. */
  forceWebGL?: boolean;
  /** Room name and area labels in plan and dollhouse views. */
  labels?: boolean;
  /** Number format of the room areas in those labels, as a BCP 47 tag. Default `de-DE`. */
  locale?: string;
  /** Paper tone behind the plan and dollhouse; match the page's colour scheme. Default `light`. */
  theme?: ViewerTheme;
  onProgress?: (p: ViewerProgress) => void;
  onModeChange?: (mode: ViewerMode) => void;
  onRoomChange?: (room: RoomInfo | null) => void;
  /**
   * Lets someone edit the house by hand (see `Viewer.editor`). It shows merged as usual and comes
   * apart in place only between `editor.start()` and `editor.stop()`, which costs frame rate.
   */
  editable?: boolean;
  /** The full shared library, for an editable viewer, e.g. "/viewer/library/". */
  catalogBase?: string;
  signal?: AbortSignal;
}

export interface Viewer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly quality: 'full' | 'lite';
  /** Resolves once every model and first-pass texture has loaded (state.ready). */
  readonly ready: Promise<void>;
  /** Resolves once the HDRI sky and the full-resolution textures are in too. */
  readonly loaded: Promise<void>;
  /** Guided flythrough; state in getState().tour. Any input on the canvas pauses it. */
  readonly tour: Tour;
  /** Hand editing, in a viewer made `editable`; null otherwise. */
  readonly editor: ViewerEditor | null;
  setMode(mode: ViewerMode): void;
  setTime(t: number): void;
  setCut(on: boolean): void;
  setFurniture(visible: boolean): void;
  /** Shows or hides the plan's own roofs in the dollhouse. */
  setRoof(visible: boolean): void;
  /** The plan's design options; empty for a plan without them. */
  designOptions(): DesignOptionInfo[];
  /** Shows another design option in place: its finishes and furniture, keeping the view. */
  setDesignOption(id: string): void;
  setGrid(on: boolean): void;
  setTheme(theme: ViewerTheme): void;
  rooms(): RoomInfo[];
  /** Storeys bottom to top; empty for a single-storey plan. */
  levels(): LevelInfo[];
  /** Shows one storey: cut there in plan and dollhouse, standing on it in walk. */
  setLevel(id: string): void;
  focusRoom(id: string): void;
  /** Captures the mouse for walk mode; a click on the canvas does the same. */
  lockPointer(): void;
  /**
   * While set, a click on the canvas (not a drag) reports what it hit, and walk mode leaves the
   * mouse free. A locked pointer picks at the crosshair.
   */
  setPicking(onPick: ((pick: ViewerPick | null) => void) | null): void;
  /** Pins `element` to a world point. It follows the camera and hides off screen. Returns a remover. */
  addMarker(point: Vec3, element: HTMLElement): () => void;
  getView(): ViewerView;
  /** Switches to the view's mode and flies the camera there. */
  setView(view: ViewerView): void;
  /** Opens or closes a door by opening ID; without `open` it toggles from its authored pose. */
  toggleDoor(id: string, open?: boolean): void;
  doors(): { id: string; open: boolean }[];
  getState(): ViewerState;
  /** For useSyncExternalStore: calls back after every state change. */
  subscribe(listener: () => void): () => void;
  stats(): ViewerStats;
  dispose(): void;
}

const PAPER: Record<ViewerTheme, string> = { light: '#f6f4ef', dark: '#1c1b19' };
// Light paper turns to a dark ground at night; dark paper is already dark and keeps its own tone.
const NIGHT_PAPER: Record<ViewerTheme, string> = { light: '#24282d', dark: PAPER.dark };
// The house shadow on dark paper needs more weight to read at all.
const GROUND_SHADOW: Record<ViewerTheme, number> = { light: 0.28, dark: 0.38 };
const FLY_MS = 1100;
const DOOR_REACH = 2.2;
const DOOR_CONE = THREE.MathUtils.degToRad(35);
const DEFAULT_TIME = 16 / 24;
/**
 * Times the warm-up draws: the day light set, the evening set, and the evening set while the
 * walk-mode sky is still a texture (dusk). Every other time differs from these by intensities only.
 */
const WARM_TIME = { day: 13 / 24, dusk: (19 + 40 / 60) / 24, night: 22 / 24 };

/** Mounts the viewer into `host` (sized by its CSS) and resolves after the first frame. */
/** Ends the current task so the browser can paint and handle input between load phases. */
function yieldToMain() {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return s?.yield ? s.yield() : new Promise<void>((res) => setTimeout(res, 0));
}

export async function createViewer(host: HTMLElement, opts: ViewerOptions): Promise<Viewer> {
  const t0 = performance.now();
  const cleanup: (() => void)[] = [];
  const abort = new AbortController();
  const signal = abort.signal;
  // An already-aborted signal never fires 'abort'.
  if (opts.signal?.aborted) abort.abort();
  else opts.signal?.addEventListener('abort', () => abort.abort(), { signal });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    for (const fn of cleanup.splice(0).reverse()) fn();
  };
  const check = () => {
    if (signal.aborted) {
      dispose();
      throw new DOMException('Viewer creation aborted', 'AbortError');
    }
  };

  let assetsLoaded = 0, assetsTotal = 0;
  let phase: ViewerProgress['phase'] = 'renderer';
  let reported = 0;
  // The asset total grows as models ask for their textures, so loaded/total alone can fall back.
  const report = (p: ViewerProgress['phase'], progress: number) => {
    phase = p;
    reported = Math.max(reported, progress);
    opts.onProgress?.({ phase: p, progress: reported, loaded: assetsLoaded, total: assetsTotal });
  };
  report('renderer', 0);

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.style.overflow = 'hidden';

  const caps = await capabilities();
  check();
  const lite = opts.quality === 'lite' || (opts.quality !== 'full' && caps.recommended === 'lite');
  const [stage, plan, library] = await Promise.all([
    Stage.create(host, { forceWebGL: opts.forceWebGL, lite }),
    opts.plan
      ? Promise.resolve(structuredClone(opts.plan))
      : (takePrefetched(opts.planUrl!) ?? fetch(opts.planUrl!, { signal })).then((r) => {
          if (!r.ok) throw new Error(`Plan not found at ${opts.planUrl} (${r.status})`);
          return r.json() as Promise<Plan>;
        }),
    Library.load(opts.assetBase, opts.planUrl, signal, opts.editable ? opts.catalogBase : undefined),
  ]).catch((e) => {
    dispose();
    throw e;
  });
  cleanup.push(() => stage.dispose());
  check();
  report('plan', 0.1);

  const manager = new THREE.LoadingManager();
  let markReady!: () => void;
  const ready = new Promise<void>((res) => (markReady = res));
  manager.onProgress = (_url, loaded, total) => {
    assetsLoaded = loaded;
    assetsTotal = total;
    if (phase === 'plan' || phase === 'assets') report('assets', 0.1 + 0.6 * (loaded / Math.max(1, total)));
    stage.requestRender();
  };

  const orbitCam = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  const planCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  const canvas = stage.renderer.domElement;
  const walker = new Walker(canvas, 1);
  cleanup.push(() => walker.dispose());
  const overlay = new PlanOverlay();
  cleanup.push(() => overlay.clear());
  stage.scene.add(overlay.group);

  const orbit = new OrbitControls(orbitCam, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.maxPolarAngle = Math.PI * 0.47;
  orbit.minDistance = 2;
  orbit.maxDistance = 80;
  // Explicit mouse buttons stay consistent over both the house and its surroundings.
  orbit.screenSpacePanning = false;
  orbit.panSpeed = 0.65;
  // The right button is free look (see FlyCamera); Shift, Control or Command with the left button pans.
  orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };
  const freeLook = new FlyCamera(orbitCam);
  const planControls = new OrbitControls(planCam, canvas);
  planControls.enableRotate = false;
  planControls.screenSpacePanning = true;
  planControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  planControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
  planControls.enabled = false;
  cleanup.push(() => {
    orbit.dispose();
    planControls.dispose();
  });

  let state: ViewerState = {
    mode: opts.mode ?? 'dollhouse',
    time: Math.min(1, Math.max(0, opts.time ?? DEFAULT_TIME)),
    night: false,
    cut: opts.cut ?? false,
    furniture: true,
    roof: null,
    designOption: null,
    grid: true,
    room: null,
    level: null,
    locked: false,
    ready: false,
    tour: IDLE_TOUR,
    closedDoors: [],
    selected: null,
    blocked: null,
  };
  const listeners = new Set<() => void>();
  const setState = (patch: Partial<ViewerState>) => {
    const next = { ...state, ...patch };
    if ((Object.keys(patch) as (keyof ViewerState)[]).every((k) => next[k] === state[k])) return;
    const prev = state;
    state = next;
    if (next.mode !== prev.mode) opts.onModeChange?.(next.mode);
    if (next.room !== prev.room) opts.onRoomChange?.(roomInfo(next.room));
    for (const l of listeners) l();
  };

  // Floors are seen closest and get the largest maps; walls and furniture stop at 1024 px, phones
  // everywhere. Phones load that size directly: two passes would cost them more data than time.
  const pbrSet = (id: string, floor: boolean) => library.texture(id, lite || !floor ? NON_FLOOR_MAX : Infinity, !lite);
  const lib = new MaterialLibrary(plan, library.resolve, stage.renderer.getMaxAnisotropy(), pbrSet, { manager });
  cleanup.push(() => lib.dispose());
  let house: BuiltHouse;
  try {
    house = await buildHouse(plan, lib, { resolveUrl: library.resolve, modelInfo: library.model, manager, lampShadows: !lite, editable: opts.editable });
  } catch (e) {
    dispose();
    throw e;
  }
  cleanup.push(() => house.dispose());
  report('build', 0.78);
  await yieldToMain();
  check();
  check();

  const storeyed = house.levels.length > 1;
  if (house.roofs.children.length) state = { ...state, roof: true };
  state = { ...state, designOption: house.designOption };
  function showDesignOption(id: string) {
    const option = plan.designOptions?.find((o) => o.id === id);
    if (!option || id === house.designOption) return;
    house.setDesignOption(option);
    // The walker meets the furniture of the look on show.
    walker.setWorld(state.furniture ? house.colliders : house.collidersFixed);
    stage.invalidateShadows();
    refreshLampShadows();
    setState({ designOption: id });
  }
  const roomList: RoomInfo[] = house.rooms.map((r) => ({
    id: r.room.id,
    name: r.room.name,
    area: Math.round(r.netArea * 10) / 10,
    centroid: [r.center.x, r.center.z],
    ...(storeyed && { level: r.level.id }),
  }));
  const roomInfo = (id: string | null) => roomList.find((r) => r.id === id) ?? null;
  const levelList: LevelInfo[] = storeyed ? house.levels.map(({ level }) => ({ id: level.id, name: level.name, elevation: level.elevation })) : [];
  const storeyPlans = new Map(house.levels.map(({ level }) => [level.id, levelPlan(plan, level)]));
  const lowest = house.levels[0], highest = house.levels[house.levels.length - 1];
  /** The storey someone picked, or the walker's floor; null until then. */
  let chosen: BuiltLevel | null = null;
  /** Plan cuts the lowest storey and the dollhouse shows the whole house until a storey is picked. */
  const shownLevel = (mode: ViewerMode) => chosen ?? (mode === 'dollhouse' ? highest : lowest);
  const builtLevel = (id: string | undefined) => house.levels.find((l) => l.level.id === levelOf(plan, id).id) ?? lowest;
  const levelHere = (y: number) => builtLevel(levelAt(plan, y).id);
  /** Room under a point, among the rooms on the storey at height `y`. */
  const roomHere = (x: number, z: number, y: number) => roomAt(storeyPlans.get(levelHere(y).level.id)!, [x, z]);

  stage.scene.add(house.root);
  for (const o of [...house.daylight.children, ...house.lights.children]) o.userData.intensity = (o as THREE.Light).intensity;
  walker.setWorld(house.colliders);

  // ---------- doors ----------

  const doors = openingDoors(house.root);
  setState({ closedDoors: [...doors.values()].filter(door => door.target === 0).map(door => door.id) });
  const doorBoxes: THREE.Box3[] = [];
  walker.blockers = () => {
    doorBoxes.length = 0;
    for (const d of doors.values()) if (d.t === 0 && d.target === 0) doorBoxes.push(d.closedBox);
    return doorBoxes;
  };
  // Lamp cube maps keep full walls in every mode, so each room keeps its own light in the cutaway.
  // Their shadow passes see the clip plane above the house; three projects the plane before it
  // draws a pass, and only the uniform values change, so no pipeline is added.
  const lamps = house.lights.children.filter((o): o is THREE.PointLight => (o as THREE.PointLight).isPointLight && o.castShadow);
  const lampCams = new Set<THREE.Camera>(lamps.map((l) => l.shadow.camera));
  let heldCut: number | null = null;
  stage.scene.onBeforeRender = (_r, _s, camera) => {
    if (!lampCams.has(camera)) return;
    heldCut = house.clipPlane.constant;
    house.clipPlane.constant = NO_CUT;
  };
  stage.scene.onAfterRender = (_r, _s, camera) => {
    if (heldCut === null || !lampCams.has(camera)) return;
    house.clipPlane.constant = heldCut;
    heldCut = null;
  };
  let doorsMoving = false;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function setDoor(d: Door, open: boolean) {
    d.target = open ? 1 : 0;
    if (reducedMotion()) d.t = d.target;
    d.moving = doorsMoving = true;
    stage.requestRender();
    setState({ closedDoors: [...doors.values()].filter((x) => x.target === 0).map((x) => x.id) });
  }
  function stepDoors(dt: number) {
    if (!doorsMoving) return;
    doorsMoving = false;
    let settled = false;
    for (const d of doors.values()) {
      if (!d.moving) continue;
      d.t = d.target > d.t ? Math.min(d.target, d.t + dt / 0.5) : Math.max(d.target, d.t - dt / 0.5);
      const e = d.t < 0.5 ? 4 * d.t ** 3 : 1 - (-2 * d.t + 2) ** 3 / 2;
      poseDoor(d, e);
      d.moving = d.t !== d.target;
      if (!d.moving) settled = true;
      else doorsMoving = true;
    }
    if (settled) {
      stage.invalidateShadows();
      refreshLampShadows();
    }
    stage.requestRender();
  }
  /** Lamps outside the current light set render their maps once they are drawn again. */
  function refreshLampShadows() {
    for (const l of lamps) l.shadow.needsUpdate = true;
    stage.requestRender();
  }
  function openAllDoors() {
    for (const d of doors.values()) {
      d.t = d.target = 1;
      d.moving = false;
      poseDoor(d, 1);
    }
    stage.invalidateShadows();
    refreshLampShadows();
    setState({ closedDoors: [] });
  }

  const b = house.bounds;
  const pad = 0.5;
  const houseBox = new THREE.Box3(
    new THREE.Vector3(b.minX - pad, -0.35, b.minY - pad),
    new THREE.Vector3(b.maxX + pad, Math.max(...house.levels.map(({ level }) => {
      const storey = storeyPlans.get(level.id)!;
      return level.elevation + Math.max(...storey.walls.map((w) => w.height ?? withDefaults(storey).wallHeight));
    })) + 0.2, b.maxY + pad),
  );
  stage.fitSun(houseBox);
  stage.north = plan.north ?? 0;
  stage.setTimeOfDay(state.time);
  state = { ...state, night: sunElevation(state.time) < 0 };

  // ---------- labels ----------

  if (opts.labels ?? true) {
    const area = new Intl.NumberFormat(opts.locale ?? 'de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    for (const r of house.rooms) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'arch-room-label';
      Object.assign(el.style, {
        display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.2rem 0.45rem', font: 'inherit',
        color: 'var(--arch-viewer-label-fg, #1f1e1b)', background: 'var(--arch-viewer-label-bg, rgb(246 244 239 / 0.86))',
        border: '1px solid var(--arch-viewer-label-border, #d9d4ca)', borderRadius: '4px', lineHeight: '1.25',
        whiteSpace: 'nowrap', pointerEvents: 'auto', cursor: 'pointer',
      } satisfies Partial<CSSStyleDeclaration>);
      const name = document.createElement('span');
      Object.assign(name.style, { fontWeight: '600', fontSize: '12px' });
      name.textContent = r.room.name;
      const size = document.createElement('span');
      Object.assign(size.style, { fontSize: '11px', opacity: '0.7', fontVariantNumeric: 'tabular-nums' });
      size.textContent = `${area.format(r.netArea)} m²`;
      el.append(name, size);
      el.addEventListener('click', () => focusRoom(r.room.id));
      // CSS2DRenderer resets `display` on the element it positions, so the flex label sits inside it.
      const anchor = document.createElement('div');
      anchor.append(el);
      const o = new CSS2DObject(anchor);
      o.position.set(r.center.x, r.center.y + CUT_HEIGHT + 0.3, r.center.z);
      o.name = 'label';
      o.userData.level = r.level.id;
      house.root.add(o);
      cleanup.push(() => anchor.remove());
    }
  }
  await overlay.build(plan, plan.source ? library.resolve(plan.source.image) : undefined);
  check();

  // ---------- cameras ----------

  function frameDollhouse() {
    // A portrait canvas sees less width from the same spot, so the camera backs off until the house fits.
    const aspect = (host.clientWidth || 1) / (host.clientHeight || 1);
    const r = Math.max(b.w, b.h) * Math.max(1, 1.1 / aspect);
    const y = shownLevel('dollhouse').level.elevation;
    orbit.target.set(b.cx, y + 0.8, b.cy);
    orbitCam.position.set(b.cx + r * 0.55, y + r * 1.05, b.cy + r * 1.05);
    orbit.update();
  }

  function framePlan() {
    planCam.position.set(b.cx, 40, b.cy);
    planCam.up.set(0, 0, -1);
    planCam.lookAt(b.cx, 0, b.cy);
    planControls.target.set(b.cx, 0, b.cy);
    planCam.userData.span = Math.max(b.w, b.h) + 4;
    planCam.zoom = 1;
    resize();
    planControls.update();
  }

  // Walk cameras must stand inside a room on their storey; an exterior overview would drop the walker outside.
  const insideRoom = (c: { position: number[]; level?: string }) => {
    const level = builtLevel(c.level).level;
    return house.rooms.some((r) => r.level === level && pointInPolygon([c.position[0], c.position[1]], r.room.polygon));
  };
  const placeAtCamera = (c: NonNullable<Plan['cameras']>[number]) =>
    walker.place(c.position[0], c.position[1], c.lookAt[0], c.lookAt[1], builtLevel(c.level).level.elevation);
  const placeInRoom = (r: BuiltHouse['rooms'][number]) => walker.place(r.center.x, r.center.z, r.center.x + 1, r.center.z, r.center.y);

  /** Stands the walker on a storey: at its first camera, else the middle of its largest room. */
  function placeWalkerOn(level: BuiltLevel) {
    const cam = plan.cameras?.find((c) => builtLevel(c.level) === level && insideRoom(c));
    if (cam) return placeAtCamera(cam);
    const big = house.rooms.filter((r) => r.level === level.level).sort((x, y) => y.netArea - x.netArea)[0];
    if (big) return placeInRoom(big);
    walker.place(b.cx, b.cy, b.cx + 1, b.cy, level.level.elevation);
  }

  function placeWalkerAtStart() {
    const cam = plan.cameras?.find(insideRoom);
    if (cam) return placeAtCamera(cam);
    // Otherwise step in through the front door: the first door on an exterior wall.
    const door = plan.openings?.find((o) => o.type.includes('door') && plan.walls.find((w) => w.id === o.wall)?.exterior);
    const w = door && plan.walls.find((x) => x.id === door.wall);
    if (door && w) {
      const level = builtLevel(w.level).level;
      const d = wallDir(w);
      const p = [w.a[0] + d[0] * door.offset, w.a[1] + d[1] * door.offset];
      const t = wallThickness(plan, w) / 2 + 0.7;
      for (const s of [1, -1]) {
        const q: [number, number] = [p[0] - d[1] * s * t, p[1] + d[0] * s * t];
        if (house.rooms.some((r) => r.level === level && pointInPolygon(q, r.room.polygon)))
          return walker.place(q[0], q[1], q[0] - d[1] * s, q[1] + d[0] * s, level.elevation);
      }
    }
    const big = [...house.rooms].sort((x, y) => y.netArea - x.netArea)[0];
    if (big) return placeInRoom(big);
    walker.place(b.cx, b.cy, b.cx + 1, b.cy);
  }

  let fly: { cam: THREE.Camera; controls: OrbitControls; from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; start: number; onDone?: () => void } | null = null;
  // Slow turn around a focused room; any input cancels it where it stands.
  let spin: { target: THREE.Vector3; offset: THREE.Vector3; start: number } | null = null;
  const stopFly = () => (fly = spin = null);
  orbit.addEventListener('start', stopFly);
  planControls.addEventListener('start', stopFly);

  function flyTo(cam: THREE.Camera, controls: OrbitControls, position: THREE.Vector3, target: THREE.Vector3, onDone?: () => void) {
    spin = null;
    fly = { cam, controls, from: [cam.position.clone(), controls.target.clone()], to: [position, target], start: performance.now(), onDone };
  }

  const SPIN_MS = 24000;
  function stepSpin(now: number) {
    if (!spin) return;
    const k = Math.min(1, (now - spin.start) / SPIN_MS);
    const a = (1 - Math.cos(Math.PI * k)) * Math.PI;
    orbitCam.position.copy(spin.offset).applyAxisAngle(THREE.Object3D.DEFAULT_UP, a).add(spin.target);
    orbit.target.copy(spin.target);
    if (k >= 1) spin = null;
  }

  function stepFly(now: number) {
    if (!fly) return;
    const k = Math.min(1, (now - fly.start) / FLY_MS);
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    fly.cam.position.lerpVectors(fly.from[0], fly.to[0], e);
    fly.controls.target.lerpVectors(fly.from[1], fly.to[1], e);
    if (k >= 1) {
      const done = fly.onDone;
      fly = null;
      done?.();
    }
  }

  function focusRoom(id: string) {
    const r = house.rooms.find((x) => x.room.id === id);
    if (!r) return;
    spin = null;
    if (tourCtl.active) {
      tourCtl.release();
      applyMode(state.mode);
    }
    const cam = plan.cameras?.find((c) => c.room === id && insideRoom(c));
    if (storeyed && shownLevel(state.mode).level !== r.level) {
      chosen = builtLevel(r.level.id);
      applyMode(state.mode);
    }
    if (state.mode === 'walk') {
      if (cam) placeAtCamera(cam);
      else placeInRoom(r);
    } else if (state.mode === 'dollhouse') {
      const off = orbitCam.position.clone().sub(orbit.target).setLength(Math.max(6, Math.sqrt(r.netArea) * 2.4));
      const target = new THREE.Vector3(r.center.x, r.center.y + 0.6, r.center.z);
      flyTo(orbitCam, orbit, target.clone().add(off), target, () => {
        if (!reducedMotion() && state.mode === 'dollhouse') spin = { target, offset: off, start: performance.now() };
      });
    } else {
      flyTo(planCam, planControls, new THREE.Vector3(r.center.x, 40, r.center.z), new THREE.Vector3(r.center.x, 0, r.center.z));
    }
    setState({ room: id });
  }

  // ---------- modes ----------

  let onPick: ((pick: ViewerPick | null) => void) | null = null;
  let theme: ViewerTheme = opts.theme ?? 'light';
  let onPaper = true;
  function setPaper(on: boolean) {
    onPaper = on;
    stage.groundShadow = GROUND_SHADOW[theme];
    stage.setBackground(on ? PAPER[theme] : null, on ? NIGHT_PAPER[theme] : null);
  }

  /** Wall caps of one storey, at its 1.2 m cut or under the slab above; none in walk mode. */
  function showCaps(level: BuiltLevel | null, cut: boolean) {
    for (const l of house.levels) {
      l.cutCaps.visible = l === level && cut;
      l.topCaps.visible = l === level && !cut;
    }
    house.caps.visible = !!level && (cut || level.top !== NO_CUT);
  }

  function applyMode(mode: ViewerMode) {
    // Warm-up switches looks only; flights, controls and pointer lock stay as they are.
    if (!warming) {
      fly = spin = null;
      endFreeLook();
      cancelOrbitDrag();
      orbit.enabled = mode === 'dollhouse';
      planControls.enabled = mode === 'plan';
      walker.active = mode === 'walk';
      if (mode !== 'walk') walker.unlock();
      canvas.style.cursor = baseCursor(mode);
    }

    // A section cuts the shown storey at 1.2 m; otherwise the house ends under the next floor's slab.
    const level = shownLevel(mode);
    const cut = mode === 'plan' || (mode === 'dollhouse' && state.cut);
    const clip = mode === 'walk' ? NO_CUT : cut ? level.cut : level.top;
    const roofs = mode === 'walk' || state.roof !== false;
    const changed = house.clipPlane.constant !== clip || house.ceilings.visible !== (mode === 'walk') || house.roofs.visible !== roofs;
    house.roofs.visible = roofs;
    house.clipPlane.constant = clip;
    showCaps(mode === 'walk' ? null : level, cut);
    house.ceilings.visible = mode === 'walk';
    house.root.traverse((o) => {
      if (o.name === 'label') o.visible = mode !== 'walk' && o.userData.level === level.level.id;
    });
    overlay.group.visible = mode === 'plan';
    overlay.group.position.y = level.level.elevation;
    if (!warming && storeyed) setState({ level: level.level.id });

    stage.setCamera(mode === 'walk' ? walker.camera : mode === 'plan' ? planCam : orbitCam);
    syncLights();
    // Walk mode shows the real sky through the windows; the overviews sit on paper.
    setPaper(mode !== 'walk');
    syncGround();
    // The roof and the cut change what casts sun shadows (the root clips shadow passes too).
    if (changed) stage.invalidateShadows();
    resize();
  }

  /**
   * Only the active preset's lights are visible, and the stage keeps one light registry per
   * preset, so each set keeps its compiled materials and switching costs no recompile. Within a
   * set everything fades by intensity: window spots with the sky (and under the flat plan light),
   * lamps with the dusk. Both are at zero where the stage flips sets, so the flip never shows.
   */
  function syncLights() {
    const evening = stage.preset === 'evening';
    house.lights.visible = evening;
    house.daylight.visible = !evening;
    for (const o of house.daylight.children) {
      const l = o as THREE.SpotLight;
      if (l.isSpotLight) l.intensity = state.mode === 'plan' ? 0 : l.userData.intensity * stage.skylight;
    }
    for (const o of house.lights.children) {
      const l = o as THREE.PointLight;
      if (l.isPointLight) l.intensity = l.userData.intensity * stage.lamps;
    }
    // Ceiling lenses and fixtures glow only when the room lights are on; by day they are plain diffusers.
    lib.get('bulb').emissiveIntensity = 1.2 * stage.lamps;
    stage.requestRender();
  }

  function applyTime(t: number) {
    stage.setTimeOfDay(t);
    syncLights();
  }

  /**
   * Draws every mode once in both light sets (see WARM_TIME), so the shaders, the plan pipeline
   * and the lamp shadow maps exist before anyone clicks. The first frame shows the current state; the others
   * follow in idle time after it, one per task, each drawn hidden and then covered by a redraw of
   * the real view in the same task. Walk with the cut caps shown covers the dollhouse too: same
   * pipeline, a superset of objects.
   */
  let warming = false;
  const warmQueue: [ViewerMode, number, boolean][] = [];
  function warmState([mode, time, caps]: [ViewerMode, number, boolean]) {
    const real = state;
    warming = true;
    // Everything compiles, not just what the camera happens to see.
    const culled: THREE.Object3D[] = [];
    stage.scene.traverse((o) => {
      if (o.frustumCulled) culled.push(o);
      o.frustumCulled = false;
    });
    try {
      state = { ...real, mode, time };
      applyTime(state.time);
      applyMode(mode);
      if (caps) showCaps(lowest, true);
      house.looseFurniture.visible = true;
      // Shadow passes compile per light set too.
      stage.invalidateShadows();
      stage.drawNow(false);
    } finally {
      for (const o of culled) o.frustumCulled = true;
      state = real;
      house.looseFurniture.visible = real.furniture;
      applyTime(real.time);
      applyMode(real.mode);
      stage.invalidateShadows();
      stage.drawNow();
      warming = false;
    }
  }
  function finishWarmUp() {
    while (warmQueue.length) warmState(warmQueue.shift()!);
  }
  async function warmLater() {
    const { day, dusk, night } = WARM_TIME;
    const other = stage.preset === 'evening' ? day : night;
    warmQueue.push(
      ['walk', other, true], ['walk', other === day ? night : day, true], ['walk', dusk, true],
      ['plan', day, false], ['plan', night, false], [state.mode, other, false],
    );
    const idle = () => new Promise<void>((res) => ('requestIdleCallback' in window ? requestIdleCallback(() => res(), { timeout: 400 }) : setTimeout(res, 50)));
    while (warmQueue.length && !signal.aborted) {
      await idle();
      if (signal.aborted) return;
      // Hold off while the view is moving; a hidden draw then would cost a visible frame.
      if (fly || spin || walker.locked || walker.moving || panKeys.size || tourCtl.active || doorsMoving) continue;
      warmState(warmQueue.shift()!);
    }
  }

  // ---------- guided tour ----------

  const tourCam = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  tourCam.rotation.order = 'YXZ';
  let tourLook: { inside: boolean | null; labels: boolean | null; shadowCut: number } = { inside: null, labels: null, shadowCut: Number.NaN };
  const setLabels = (on: boolean) =>
    house.root.traverse((o) => {
      if (o.name === 'label') o.visible = on;
    });

  const tourCtl = createTour({
    element: host,
    signal,
    // The tour walks the storey with the front door; stairs are not part of its route.
    rooms: () => roomList.filter((r) => !storeyed || r.level === lowest.level.id),
    path: () =>
      buildTourPath({
        plan: storeyPlans.get(lowest.level.id)!,
        rooms: roomList.filter((r) => !storeyed || r.level === lowest.level.id),
        colliders: house.colliders,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }),
    begin() {
      // The tour visits every look; compile the rest now rather than on its way through the house.
      finishWarmUp();
      // Tour paths run through doorways.
      openAllDoors();
      fly = spin = null;
      cancelOrbitDrag();
      orbit.enabled = planControls.enabled = walker.active = false;
      walker.unlock();
      canvas.style.cursor = '';
      // The roof stays in; the cut decides how much of the house shows.
      house.ceilings.visible = true;
      house.roofs.visible = true;
      showCaps(lowest, true);
      overlay.group.visible = false;
      tourLook = { inside: null, labels: null, shadowCut: Number.NaN };
      stage.setCamera(tourCam);
      // The app labels the tour's rooms while the mode reads dollhouse.
      setState({ mode: 'dollhouse' });
    },
    apply(f) {
      tourCam.position.copy(f.position);
      tourCam.rotation.set(f.pitch, f.yaw, 0);
      tourCam.fov = f.fov;
      tourCam.aspect = (host.clientWidth || 1) / (host.clientHeight || 1);
      // Clip planes follow the distance: the opening shot sits hundreds of metres up.
      tourCam.near = THREE.MathUtils.clamp(0.02 * f.focus, 0.05, 20);
      tourCam.far = Math.max(200, f.focus * 4);
      tourCam.updateProjectionMatrix();
      house.clipPlane.constant = f.cut;
      // Caps match the wall section only below the lowest lintel.
      house.caps.visible = f.cut <= 2.05;
      house.caps.position.y = house.caps.visible ? f.cut - CUT_HEIGHT : 0;
      // The sun's shadow follows the rising cut in 10 cm steps; every frame cost a 4K shadow pass.
      if (Math.abs(f.cut - tourLook.shadowCut) > 0.1 ||(f.cut === NO_CUT) !== (tourLook.shadowCut === NO_CUT)) {
        tourLook.shadowCut = f.cut;
        stage.invalidateShadows();
      }
      if (f.inside !== tourLook.inside) {
        tourLook.inside = f.inside;
        setPaper(!f.inside);
        stage.ground.visible = !f.inside || !stage.hasEnvironment;
      }
      if (f.labels !== tourLook.labels) {
        tourLook.labels = f.labels;
        setLabels(f.labels);
      }
      stage.requestRender();
    },
    end(how, f) {
      house.caps.position.y = 0;
      if (how === 'walk' && f) {
        const ahead = new THREE.Vector3(-Math.sin(f.yaw), 0, -Math.cos(f.yaw));
        // The reveal stops outside the front door; the walk starts just inside it.
        const p = f.inside ? f.position.clone() : f.position.clone().addScaledVector(ahead, OUTSIDE + 0.7);
        walker.place(p.x, p.z, p.x + ahead.x, p.z + ahead.z);
        setState({ mode: 'walk' });
        applyMode('walk');
      } else applyMode(state.mode);
    },
    update: (tour) => setState({ tour, ...(tour.roomId && { room: tour.roomId }) }),
  });

  // The HDRI has its own lawn; the flat ground disc would hide it outside the windows.
  // The plan is a drawing on paper, so it has no ground either.
  function syncGround() {
    stage.ground.visible = state.mode === 'dollhouse' || (state.mode === 'walk' && !stage.hasEnvironment);
  }

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    const aspect = w / h;
    stage.resize(w, h);
    stage.setCamera(stage.camera);
    orbitCam.aspect = aspect;
    orbitCam.updateProjectionMatrix();
    walker.camera.aspect = aspect;
    walker.camera.updateProjectionMatrix();
    const span = (planCam.userData.span as number) ?? 20;
    const halfH = aspect > 1 ? span / 2 : span / 2 / aspect;
    planCam.left = -halfH * aspect;
    planCam.right = halfH * aspect;
    planCam.top = halfH;
    planCam.bottom = -halfH;
    planCam.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(host);
  cleanup.push(() => ro.disconnect());

  // ---------- input ----------

  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
    spin = null;
    if (!freeLook.active) clickDuringLook = false;
  }, { signal });
  const cancelOrbitDrag = bindOrbitInput(canvas, [orbit, planControls], () => cursor(), signal);
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || onPick || tourCtl.active || state.mode === 'walk') return;
    if (e.button === 2 && state.mode === 'dollhouse') return;
    const modified = e.ctrlKey || e.metaKey || e.shiftKey;
    const pan = state.mode === 'plan' || (e.button === 2 ? !modified : e.button === 0 && modified);
    canvas.style.cursor = e.button === 1 ? ORBIT_CURSOR.zoom : pan ? ORBIT_CURSOR.pan : ORBIT_CURSOR.rotate;
  }, { signal });
  canvas.addEventListener('wheel', (e) => {
    spin = null;
    // While looking around, the wheel sets the flying speed instead of zooming.
    if (!freeLook.active) return;
    e.preventDefault();
    freeLook.adjustSpeed(e.deltaY);
  }, { signal, passive: false });
  // The right button belongs to free look in the dollhouse, never to the browser menu.
  canvas.addEventListener('contextmenu', (e) => {
    if (state.mode === 'dollhouse') e.preventDefault();
  }, { signal });
  document.addEventListener('mousemove', (e) => {
    if (!freeLook.active) return;
    // Chromium reports one bogus movement when the mouse is captured or released (the jump to or
    // from the window centre, hundreds of pixels). It would whip the camera around, so it is dropped.
    if (performance.now() - lockChangedAt < 60 || Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
    freeLook.look(e.movementX, e.movementY);
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) lookTurned = true;
    captureLook();
  }, { signal });
  /**
   * Captures the mouse once the look actually turns. Chromium refuses captures asked for in quick
   * succession, so a right click that never moves asks for none, and a refused one is asked again
   * each second while the button stays down (the press keeps the request allowed for a while).
   */
  function captureLook() {
    if (!lookCapture || !lookTurned || document.pointerLockElement === canvas || performance.now() - lockAskedAt < 1000) return;
    lockAskedAt = performance.now();
    try {
      const p = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      /* turning works until the cursor reaches the edge, and the next frame asks again */
    }
  }

  // ---------- free look ----------
  // One rule: free look is on exactly while the right button is held. Every mouse event carries
  // the held buttons, so each re-checks the rule; with several buttons the browser sends
  // pointerdown and pointerup only for the first and the last, so no single event is trusted.
  const syncFreeLook = (e: MouseEvent) => {
    if (e instanceof PointerEvent && e.pointerType !== 'mouse') return;
    const held = (e.buttons & 2) !== 0;
    if (freeLook.active) {
      if (e.buttons & 1) clickDuringLook = true;
      if (!held) endFreeLook();
    } else if (held && e.button === 2 && e.target === canvas && state.mode === 'dollhouse' && !onPick && !tourCtl.active) {
      // Only a press can capture the mouse; a right press added to a left drag looks without it.
      startFreeLook(e.type === 'pointerdown');
    }
  };
  canvas.addEventListener('pointerdown', syncFreeLook, { signal });
  for (const type of ['pointermove', 'pointerup', 'mouseup'] as const) document.addEventListener(type, syncFreeLook, { signal });
  document.addEventListener('pointerlockchange', () => {
    lockChangedAt = performance.now();
    const locked = document.pointerLockElement === canvas;
    // The capture is asynchronous: one that arrives after a quick right click is released at once.
    if (locked && !freeLook.active && state.mode !== 'walk') {
      document.exitPointerLock();
      return;
    }
    // Esc releases a captured mouse, and free look ends with it.
    if (!locked && freeLook.active && lookLocked) endFreeLook();
    lookLocked = locked && freeLook.active;
  }, { signal });
  addEventListener('blur', () => endFreeLook(), { signal });

  let lookLocked = false;
  /** This look may capture the mouse (it began with a press), and when it last asked. */
  let lookCapture = false;
  let lockAskedAt = -Infinity;
  let lockChangedAt = -Infinity;
  let lookTurned = false;
  /** A left press made while looking around is part of the look, never a click on the house. */
  let clickDuringLook = false;
  function startFreeLook(capture: boolean) {
    clickDuringLook = false;
    fly = spin = null;
    cancelOrbitDrag();
    orbit.enabled = false;
    freeLook.start(orbit.target);
    // A captured mouse has no cursor; until then a crosshair shows the look is on.
    canvas.style.cursor = 'crosshair';
    lookCapture = capture;
    lookTurned = false;
  }
  function endFreeLook() {
    if (!freeLook.active) return;
    lookCapture = false;
    const pivot = freeLook.end(shownLevel('dollhouse').level.elevation);
    orbit.target.copy(pivot);
    // Wherever free look went stays in reach, so the pan limit never pulls the camera back.
    panArea.expandByPoint(new THREE.Vector2(pivot.x, pivot.z));
    orbit.enabled = state.mode === 'dollhouse' && !tourCtl.active;
    orbit.update();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    cursor();
  }
  addEventListener('keydown', () => (spin = null), { signal });
  canvas.addEventListener('click', (e) => {
    if (clickDuringLook) {
      clickDuringLook = false;
      return;
    }
    if (onPick) {
      // A drag turns or pans the camera; only a click in place marks a spot.
      const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
      if (moved <= 5) onPick(pickAt(e.clientX, e.clientY));
      return;
    }
    const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
    if (moved <= 5 && !tourCtl.active && state.mode !== 'plan') {
      const d = doorAt(e.clientX, e.clientY);
      if (d) return setDoor(d, d.target === 0);
    }
    if (state.mode === 'walk' && !walker.locked) walker.lock();
  }, { signal });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE' || e.repeat || e.metaKey || e.ctrlKey || typing(e) || state.mode !== 'walk' || tourCtl.active) return;
    const d = doorAt(0, 0, true) ?? doorAhead();
    if (d) setDoor(d, d.target === 0);
  }, { signal });
  let hoverAt = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons || walker.locked || onPick || state.mode === 'plan' || tourCtl.active || e.timeStamp - hoverAt < 60) return;
    hoverAt = e.timeStamp;
    canvas.style.cursor = doorAt(e.clientX, e.clientY, walker.locked, shell)
      ? 'pointer'
      : baseCursor(state.mode);
  }, { signal });
  // Floors, walls, openings and slab: enough to tell house from ground or find a door, and
  // cheap to ray-test on hover. The merged furniture holds most triangles (about 9 ms a ray).
  const shell = house.root.children.filter((o) => ['floor', 'wall', 'opening'].includes(o.userData.part) || o.userData.collide);

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const isShown = (o: THREE.Object3D | null) => {
    for (; o; o = o.parent) if (!o.visible) return false;
    return true;
  };
  const partOf = (o: THREE.Object3D | null) => {
    for (; o && o !== house.root; o = o.parent) if (o.userData.part) return o.userData.part as string;
    return null;
  };

  /** What lies under the cursor, or under the crosshair while the pointer is locked. */
  function aim(clientX: number, clientY: number, center: boolean, far = Infinity, targets: THREE.Object3D[] = [house.root]) {
    const rect = canvas.getBoundingClientRect();
    const ndc = center
      ? new THREE.Vector2(0, 0)
      : new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, stage.camera);
    raycaster.far = far;
    const cut = house.clipPlane.constant + 0.01;
    const hit = raycaster
      .intersectObjects(targets, true)
      .find((h) => h.point.y <= cut && (h.object as THREE.Mesh).isMesh && isShown(h.object));
    raycaster.far = Infinity;
    return hit;
  }

  function doorAt(clientX: number, clientY: number, center = walker.locked, targets?: THREE.Object3D[]) {
    // The crosshair reaches only doors within arm's length.
    let o: THREE.Object3D | null = aim(clientX, clientY, center, center ? DOOR_REACH : Infinity, targets)?.object ?? null;
    for (; o && !o.userData.dynamic; o = o.parent) if (o === house.root) return null;
    for (; o; o = o.parent) if (o.userData.kind === 'opening') return doors.get(o.userData.id) ?? null;
    return null;
  }

  /** The door closest ahead of the walker, for `E` when the crosshair misses it. */
  function doorAhead() {
    const eye = walker.camera.position, look = walker.camera.getWorldDirection(new THREE.Vector3());
    const c = new THREE.Vector3();
    let best: Door | null = null, bestDist = DOOR_REACH;
    for (const d of doors.values()) {
      const to = d.closedBox.getCenter(c).sub(eye);
      const dist = to.length();
      if (dist < bestDist && to.angleTo(look) <= DOOR_CONE) {
        best = d;
        bestDist = dist;
      }
    }
    return best;
  }

  function pickAt(clientX: number, clientY: number): ViewerPick | null {
    const hit = aim(clientX, clientY, walker.locked);
    const point = hit?.point ?? raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
    if (!point) return null;
    // A wall face sits on the room's edge; a step back toward the camera lands inside the room.
    const probe = point.clone().addScaledVector(raycaster.ray.direction, -0.05);
    const roomOf = (id?: string) => {
      const r = id ? plan.rooms?.find((x) => x.id === id) : roomHere(probe.x, probe.z, probe.y);
      return r ? { id: r.id, name: r.name } : null;
    };
    const out = (kind: ViewerPick['kind'], type?: string, room?: string): ViewerPick => ({
      point: [point.x, point.y, point.z],
      kind,
      ...(type && { type }),
      room: roomOf(room),
    });
    if (!hit) return out('outside');
    const part = partOf(hit.object);
    if (part === 'furniture' || part === 'opening') {
      const found = house.parts
        .filter((p) => p.kind === part && (state.furniture || !p.loose) && shownInOption(p, state.designOption) && p.box.containsPoint(point))
        .sort((a, b) => volume(a.box) - volume(b.box))[0];
      if (part === 'furniture') {
        const f = found && plan.furniture?.find((x) => x.id === found.id);
        return out('furniture', f?.type, f?.room);
      }
      const o = found && plan.openings?.find((x) => x.id === found.id);
      return { ...out('opening', o?.type), ...(o && { id: o.id }) };
    }
    if (part === 'wall' || part === 'floor') return out(part);
    return out('other');
  }
  const volume = (box: THREE.Box3) => {
    const s = box.getSize(new THREE.Vector3());
    return s.x * s.y * s.z;
  };
  const catalog = (): EditorCatalog => {
    const sources = [library.contents, library.catalog?.contents].filter((c): c is LibraryIndex => !!c);
    const models = new Map<string, EditorCatalog['models'][number]>(), textures = new Map<string, EditorCatalog['textures'][number]>();
    for (const c of sources) {
      for (const [id, m] of Object.entries(c.models)) if (!models.has(id)) models.set(id, { id, path: `@lib/models/${id}.glb`, size: m.size });
      for (const [id, t] of Object.entries(c.textures)) if (!textures.has(id)) textures.set(id, { id, size: t.size, swatch: library.swatch(id) });
    }
    return { models: [...models.values()], textures: [...textures.values()] };
  };
  const editor = house.editor
    ? createEditor({
        house: house as BuiltHouse & { editor: NonNullable<BuiltHouse['editor']> },
        plan,
        canvas,
        scene: stage.scene,
        camera: () => stage.camera,
        allowed: () => state.mode !== 'walk' && !tourCtl.active && !onPick && !freeLook.active,
        floorHeight: () => shownLevel(state.mode).level.elevation,
        designOption: () => state.designOption,
        aim: (x, y, targets) => aim(x, y, false, Infinity, targets),
        holdCamera(held) {
          if (held) cancelOrbitDrag();
          orbit.enabled = !held && state.mode === 'dollhouse' && !tourCtl.active;
          planControls.enabled = !held && state.mode === 'plan';
        },
        changed() {
          stage.invalidateShadows();
          stage.requestRender();
        },
        report: (patch) => setState(patch),
        catalog,
        reloadCatalog: () => library.reloadCatalog(signal),
        picture: (piece) => piecePicture(stage.renderer, stage.scene.environment, piece),
        signal,
      })
    : null;

  function baseCursor(mode: ViewerMode) {
    return onPick || mode === 'walk' ? 'crosshair' : mode === 'plan' ? ORBIT_CURSOR.pan : ORBIT_CURSOR.rotate;
  }
  const cursor = () => {
    if (!tourCtl.active) canvas.style.cursor = baseCursor(state.mode);
  };
  walker.onLockChange = (locked) => setState({ locked });

  // Touch stick indicator for walk mode on phones.
  const stick = document.createElement('div');
  Object.assign(stick.style, {
    position: 'absolute', width: '96px', height: '96px', margin: '-48px 0 0 -48px', borderRadius: '50%',
    border: '1.5px solid rgb(246 244 239 / 0.8)', pointerEvents: 'none', display: 'none',
  });
  const thumb = document.createElement('span');
  Object.assign(thumb.style, {
    position: 'absolute', left: '50%', top: '50%', width: '36px', height: '36px', margin: '-18px 0 0 -18px',
    borderRadius: '50%', background: 'rgb(246 244 239 / 0.85)',
  });
  stick.append(thumb);
  host.append(stick);
  cleanup.push(() => stick.remove());

  // Dollhouse WASD: slides the orbit target and camera together across the ground plane.
  const panKeys = new Set<string>();
  const typing = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable]');
  addEventListener('keydown', (e) => {
    if (!typing(e) && !e.metaKey && !e.ctrlKey) panKeys.add(e.code);
  }, { signal });
  addEventListener('keyup', (e) => panKeys.delete(e.code), { signal });
  addEventListener('blur', () => panKeys.clear(), { signal });
  const panForward = new THREE.Vector3(), panRight = new THREE.Vector3(), panMove = new THREE.Vector3();
  function panDollhouse(dt: number) {
    const x = Number(panKeys.has('KeyD') || panKeys.has('ArrowRight')) - Number(panKeys.has('KeyA') || panKeys.has('ArrowLeft'));
    const z = Number(panKeys.has('KeyW') || panKeys.has('ArrowUp')) - Number(panKeys.has('KeyS') || panKeys.has('ArrowDown'));
    if (!x && !z) return;
    fly = null;
    orbitCam.getWorldDirection(panForward).setY(0);
    if (panForward.lengthSq() < 1e-6) panForward.set(0, 0, -1);
    panForward.normalize();
    panRight.crossVectors(panForward, orbitCam.up).normalize();
    // Speed scales with how far out the camera is, so a close look and a whole-house view both feel right.
    const dist = orbitCam.position.distanceTo(orbit.target);
    const speed = Math.max(1.5, dist * 0.6) * (panKeys.has('ShiftLeft') || panKeys.has('ShiftRight') ? 2.5 : 1);
    panMove.copy(panForward).multiplyScalar(z).addScaledVector(panRight, x).normalize().multiplyScalar(speed * Math.min(dt, 0.1));
    orbitCam.position.add(panMove);
    orbit.target.add(panMove);
  }

  // Keeps panning from dragging the house out of view: the pivot stays over the house or near it,
  // or wherever free look last went.
  const PAN_MARGIN = Math.max(6, Math.max(b.w, b.h) / 2);
  const panArea = new THREE.Box2(new THREE.Vector2(b.minX - PAN_MARGIN, b.minY - PAN_MARGIN), new THREE.Vector2(b.maxX + PAN_MARGIN, b.maxY + PAN_MARGIN));
  const clampShift = new THREE.Vector3();
  function clampOrbit() {
    const t = orbit.target;
    clampShift.set(
      THREE.MathUtils.clamp(t.x, panArea.min.x, panArea.max.x) - t.x,
      0,
      THREE.MathUtils.clamp(t.z, panArea.min.y, panArea.max.y) - t.z,
    );
    if (!clampShift.x && !clampShift.z) return;
    t.add(clampShift);
    orbitCam.position.add(clampShift);
  }

  // ---------- loop ----------

  const timer = new THREE.Timer();
  let frames = 0, fps = 0, fpsFrames = 0, fpsStart = performance.now();
  let raf = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    timer.update();
    const dt = timer.getDelta();
    const now = performance.now();
    if (tourCtl.active) {
      tourCtl.tick(dt, (host.clientWidth || 1) / (host.clientHeight || 1));
    } else if (state.mode === 'walk') {
      walker.update(dt);
      const s = walker.stick;
      stick.style.display = s ? 'block' : 'none';
      if (s) {
        const box = host.getBoundingClientRect();
        stick.style.left = `${s.x0 - box.left}px`;
        stick.style.top = `${s.y0 - box.top}px`;
        thumb.style.transform = `translate(${s.dx * 30}px, ${s.dy * 30}px)`;
      }
      if (frames % 15 === 0) {
        const p = walker.position;
        // Taking the stairs changes the storey on show. Walking the floor already shown picks nothing,
        // so the dollhouse keeps showing the whole house after a walk downstairs.
        const level = levelHere(p.y);
        if (storeyed && level !== shownLevel('walk')) chosen = level;
        setState({ room: roomHere(p.x, p.z, p.y)?.id ?? null, ...(storeyed && { level: level.level.id }) });
      }
    } else if (state.mode === 'dollhouse' && freeLook.active) {
      // The orbit would turn the camera back to its old pivot; it rests until the look ends.
      freeLook.move(dt, panKeys);
      captureLook();
    } else if (state.mode === 'dollhouse') {
      panDollhouse(dt);
      stepFly(now);
      stepSpin(now);
      orbit.update();
      clampOrbit();
    } else {
      stepFly(now);
      planControls.update();
    }
    stepDoors(dt);
    frames++;
    if (stage.renderIfNeeded(now)) fpsFrames++;
    if (now - fpsStart >= 1000) {
      fps = Math.round((fpsFrames * 1000) / (now - fpsStart));
      fpsFrames = 0;
      fpsStart = now;
    }
  }
  cleanup.push(() => cancelAnimationFrame(raf));

  frameDollhouse();
  framePlan();
  placeWalkerAtStart();
  applyTime(state.time);
  applyMode(state.mode);

  await yieldToMain();
  check();
  // Pipelines for the scene pass compile asynchronously here instead of in one blocking first draw.
  await stage.compile((done) => report('compile', 0.78 + 0.14 * done));
  check();
  await yieldToMain();
  check();
  stage.render();
  await new Promise<void>((res) => requestAnimationFrame(() => res()));
  check();
  const firstFrameMs = performance.now() - t0;
  performance.mark('arch:first-frame');
  const warmStart = performance.now();
  let warmMs = 0;
  warmLater().then(() => (warmMs = performance.now() - warmStart));
  report('first-frame', 0.97);
  loop();

  const allIn = () => assetsTotal === 0 || assetsLoaded >= assetsTotal;
  if (allIn()) markReady();
  else manager.onLoad = () => markReady();
  ready.then(() => {
    if (disposed) return;
    performance.mark('arch:ready');
    report('ready', 1);
    setState({ ready: true });
  });

  // The sky and the full-resolution textures stream in after the house is complete.
  const loaded = ready.then(async () => {
    if (disposed) return;
    const hdri = library.hdri(plan.environment ?? 'suburban_garden');
    await Promise.all([
      // Phones light with the small HDRI copy only and keep the procedural sky in the windows.
      stage.setEnvironment(hdri, { sky: !lite }).then(() => {
        if (!disposed) syncGround();
      }),
      lib.upgradeTextures(3, () => stage.requestRender()),
    ]);
    if (!disposed) performance.mark('arch:loaded');
  });

  function sceneLoad(): ViewerStats['scene'] {
    let meshes = 0, triangles = 0;
    const materials = new Set<THREE.Material>();
    const cut = house.clipPlane.constant;
    house.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const box = (mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox))!;
      if (box.min.y + mesh.matrixWorld.elements[13] > cut) return;
      meshes++;
      const g = mesh.geometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3 * ((mesh as THREE.InstancedMesh).count ?? 1);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
    });
    const physical = [...materials].filter((m) => (m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).length;
    const lampShadows = house.lights.visible ? lamps.filter((l) => l.castShadow).length : 0;
    return { meshes, triangles: Math.round(triangles), materials: materials.size, physical, lampShadows };
  }

  const viewer: Viewer = {
    backend: stage.isWebGPU ? 'webgpu' : 'webgl2',
    quality: lite ? 'lite' : 'full',
    ready,
    loaded,
    tour: tourCtl.tour,
    editor,
    setMode(mode) {
      if (tourCtl.active) tourCtl.release();
      else if (mode === state.mode) return;
      setState({ mode });
      applyMode(mode);
    },
    setTime(t) {
      t = Math.min(1, Math.max(0, t));
      if (t === state.time) return;
      applyTime(t);
      setState({ time: t, night: stage.elevation < 0 });
    },
    setCut(on) {
      if (on === state.cut) return;
      setState({ cut: on });
      // A running tour owns the cut; the setting applies once it ends.
      if (!tourCtl.active) applyMode(state.mode);
    },
    setFurniture(visible) {
      if (visible === state.furniture) return;
      house.looseFurniture.visible = visible;
      walker.setWorld(visible ? house.colliders : house.collidersFixed);
      stage.invalidateShadows();
      refreshLampShadows();
      setState({ furniture: visible });
    },
    setRoof(visible) {
      if (state.roof === null || visible === state.roof) return;
      setState({ roof: visible });
      // A running tour shows the roof; the setting applies once it ends.
      if (!tourCtl.active) applyMode(state.mode);
    },
    setGrid(on) {
      overlay.grid.visible = on;
      stage.requestRender();
      setState({ grid: on });
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      setPaper(onPaper);
    },
    rooms: () => roomList.map((r) => ({ ...r, centroid: [...r.centroid] })),
    levels: () => levelList.map((l) => ({ ...l })),
    designOptions: () => (plan.designOptions ?? []).map(({ id, name }) => ({ id, name })),
    setDesignOption: showDesignOption,
    setLevel(id) {
      const level = house.levels.find((l) => l.level.id === id);
      if (!storeyed || !level) return;
      if (tourCtl.active) tourCtl.release();
      spin = null;
      const from = shownLevel(state.mode).level.elevation;
      chosen = level;
      if (state.mode === 'walk') placeWalkerOn(level);
      else if (state.mode === 'dollhouse') {
        // Same view, lifted or lowered to the storey.
        const rise = new THREE.Vector3(0, level.level.elevation - from, 0);
        flyTo(orbitCam, orbit, orbitCam.position.clone().add(rise), orbit.target.clone().add(rise));
      }
      applyMode(state.mode);
      if (state.mode !== 'walk' && roomInfo(state.room)?.level !== id) setState({ room: null });
    },
    focusRoom,
    lockPointer() {
      if (state.mode === 'walk') walker.lock();
    },
    setPicking(cb) {
      onPick = cb;
      cursor();
    },
    addMarker(point, element) {
      const o = new CSS2DObject(element);
      o.position.set(...point);
      o.name = 'marker';
      stage.scene.add(o);
      stage.requestRender();
      return () => {
        o.removeFromParent();
        element.remove();
        stage.requestRender();
      };
    },
    getView() {
      if (tourCtl.active) {
        const ahead = tourCam.getWorldDirection(new THREE.Vector3()).multiplyScalar(6).add(tourCam.position);
        return { mode: 'dollhouse', position: tourCam.position.toArray(), target: ahead.toArray() };
      }
      const level = state.level ?? undefined;
      const designOption = state.designOption ?? undefined;
      if (state.mode === 'walk') {
        const eye = walker.camera.position;
        const ahead = walker.camera.getWorldDirection(new THREE.Vector3()).add(eye);
        return { mode: 'walk', position: eye.toArray(), target: ahead.toArray(), ...(level && { level }), ...(designOption && { designOption }) };
      }
      const [cam, controls] = state.mode === 'plan' ? [planCam, planControls] : [orbitCam, orbit];
      return { mode: state.mode, position: cam.position.toArray(), target: controls.target.toArray(), ...(level && { level }), ...(designOption && { designOption }) };
    },
    setView({ mode, position, target, level, designOption }) {
      if (tourCtl.active) tourCtl.release();
      if (designOption !== undefined) showDesignOption(designOption);
      if (storeyed && level !== undefined) chosen = house.levels.find((l) => l.level.id === level) ?? chosen;
      setState({ mode });
      applyMode(mode);
      // The eye stands 1.6 m above the floor it is on.
      if (mode === 'walk') walker.place(position[0], position[2], target[0], target[2], levelHere(position[1] - 1.6).level.elevation);
      else if (mode === 'plan') flyTo(planCam, planControls, new THREE.Vector3(...position), new THREE.Vector3(...target));
      else flyTo(orbitCam, orbit, new THREE.Vector3(...position), new THREE.Vector3(...target));
    },
    toggleDoor(id, open) {
      const d = doors.get(id);
      if (d) setDoor(d, open ?? d.target === 0);
    },
    doors: () => [...doors.values()].map((d) => ({ id: d.id, open: d.target === 1 })),
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats: () => ({
      backend: stage.isWebGPU ? 'webgpu' : 'webgl2',
      quality: lite ? 'lite' : 'full',
      firstFrameMs: Math.round(firstFrameMs),
      fps,
      renderScale: stage.renderScale,
      scene: sceneLoad(),
    }),
    dispose() {
      listeners.clear();
      dispose();
    },
  };

  if (import.meta.env.DEV) {
    const w = window as Window & { __arch?: unknown };
    w.__arch = { viewer, stage, walker, orbit, house, THREE, warmMs: () => warmMs };
    cleanup.push(() => {
      if ((w.__arch as { viewer?: Viewer } | undefined)?.viewer === viewer) delete w.__arch;
    });
  }
  return viewer;
}
