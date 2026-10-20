import * as THREE from 'three/webgpu';
import { pass, mrt, normalView, output, vec4, packNormalToRGB, unpackRGBToNormal, sample, renderOutput, mix, float, Fn, texture, reference, vec2, type vec3, add } from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { denoise } from 'three/examples/jsm/tsl/display/DenoiseNode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { HdriSet } from './library.ts';

export type LightPreset = 'day' | 'evening';

export interface StageOptions {
  /** Use the WebGL2 backend even where WebGPU is available. */
  forceWebGL?: boolean;
  /** Phone profile: 1.25× pixels, fewer AO samples, 2K sun shadows. */
  lite?: boolean;
}

/** Unit vector toward the sun light, kept a few degrees above the horizon so its shadow box stays bounded. */
const SUN_DIR = new THREE.Vector3(-0.45, 0.72, 0.52).normalize();
/** Where the sun should come from in plan terms: the garden side, front-left of the dollhouse view. */
const SUN_HOME = SUN_DIR.clone();
const UP = new THREE.Vector3(0, 1, 0);

/** Sunrise and sunset in hours, a spring or autumn day at a German site in summer time. */
export const SUNRISE = 6.5;
export const SUNSET = 19.5;
/** Highest sun at solar noon, in degrees. */
const NOON_ELEVATION = 52;
/**
 * Sun elevation where the light set flips between the day lights (window spots) and the evening
 * lights (lamps). Both sides fade their own lights to zero here, so the flip itself is invisible.
 */
const SWITCH_ELEVATION = 2;

const smooth = (x: number, a: number, b: number) => THREE.MathUtils.smoothstep(x, a, b);

/** Sun elevation in degrees for t = 0..1 over 00:00..24:00; negative while the sun is down. */
export function sunElevation(t: number) {
  const p = (t * 24 - SUNRISE) / (SUNSET - SUNRISE);
  return NOON_ELEVATION * Math.sin(Math.PI * p);
}

/** How the light blends at a sun elevation; every factor runs 0..1 and changes smoothly. */
function lightMix(el: number) {
  return {
    /** Direct sun, gone a moment before it touches the horizon. */
    sun: smooth(el, -0.5, 6),
    /** Sky against night: hemisphere, environment, exposure and background. */
    day: smooth(el, -8, 8),
    /** Window spots, down to nothing at the switch. */
    skylight: smooth(el, SWITCH_ELEVATION, 14),
    /** Room lamps, from nothing at the switch to full by the end of dusk. */
    lamps: 1 - smooth(el, -5, SWITCH_ELEVATION),
    golden: 1 - smooth(el, 0, 28),
  };
}

const DAY_HEMI = { sky: new THREE.Color('#ffffff'), ground: new THREE.Color('#e4e1dc'), intensity: 2.3 };
// Dusk fill: enough to read the outside walls in the overview, low enough for lamps to lead.
// Its ground stands in for the lamps' warm bounce off floors and walls, which keeps ceilings from going brown.
const NIGHT_HEMI = { sky: new THREE.Color('#c9d2e0'), ground: new THREE.Color('#a8907a'), intensity: 0.3 };
const NOON_SUN = new THREE.Color(1, 0.97, 0.93);
const LOW_SUN = new THREE.Color(1, 0.76, 0.52);
/** Walk-mode sky behind the windows once the sky texture has faded out. */
const NIGHT_SKY = '#1d242c';
/** Display refresh rates the frame-rate target snaps to. */
const REFRESH_RATES = [60, 72, 75, 90, 100, 120, 144, 165, 240];

function near(a: THREE.Matrix4, b: THREE.Matrix4, eps = 1e-7) {
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i] - b.elements[i]) > eps) return false;
  return true;
}

/** Khronos PBR Neutral, as three's NeutralToneMapping applies it to a linear color. */
function neutral(c: THREE.Color) {
  const x = Math.min(c.r, c.g, c.b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  const out = c.clone().addScalar(-offset);
  const peak = Math.max(out.r, out.g, out.b);
  if (peak < 0.76) return out;
  const d = 0.24;
  const newPeak = 1 - (d * d) / (peak + d - 0.76);
  out.multiplyScalar(newPeak / peak);
  const g = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return out.lerp(new THREE.Color(newPeak, newPeak, newPeak), g);
}

/** Linear color that lands exactly on `hex` on screen after exposure and Neutral tone mapping. */
function untonemapped(hex: string, exposure: number) {
  const target = new THREE.Color(hex);
  const c = target.clone();
  for (let i = 0; i < 40; i++) {
    const f = neutral(c.clone().multiplyScalar(exposure));
    c.r += (target.r - f.r) / exposure;
    c.g += (target.g - f.g) / exposure;
    c.b += (target.b - f.b) / exposure;
  }
  return c;
}

/** Tap offsets in texels and tent weights of the sun shadow filter. */
const TENT: [number, number, number][] = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y): [number, number, number] => [x, y, ((2 - Math.abs(x)) * (2 - Math.abs(y))) / 16]));

/**
 * Sun shadow filter: nine hardware-filtered taps in a tent, spaced `shadow.radius` texels apart.
 * three's PCF turns five taps per pixel and leaves the smoothing to a temporal filter; with render
 * on demand there is none, so its penumbra stayed dithered.
 */
const tentShadow = Fn(({ depthTexture, shadowCoord, shadow }: { depthTexture: THREE.Texture; shadowCoord: ReturnType<typeof vec3>; shadow: THREE.LightShadow }) => {
  const step = reference('radius', 'float', shadow).div(reference('mapSize', 'vec2', shadow).x);
  const taps = TENT.map(([x, y, w]) => texture(depthTexture, shadowCoord.xy.add(vec2(x, y).mul(step))).compare(shadowCoord.z).mul(w));
  return add(...(taps as [typeof taps[0], typeof taps[0], ...typeof taps]));
});

/** three's render call depth of the scene pass: output, SMAA edges, the AO composite, then the scene. */
const SCENE_PASS_DEPTH = 3;

/** PMREM cube size of the environment light. */
const ENV_SIZE = 512;

/**
 * Renderer, scene, lights and post-processing, tuned for a calm architectural look that is
 * cheap to draw: one scene pass (color plus view normals), half-resolution GTAO for soft
 * contact shadows, Neutral tone mapping and SMAA. Light comes from one shadowed sun, a sky
 * hemisphere and the environment map; no bloom, grain, vignette or temporal effects, so a
 * still camera needs no further frames and the loop can stop drawing (`renderIfNeeded`).
 */
export class Stage {
  readonly renderer: THREE.WebGPURenderer;
  readonly labels: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly sun = new THREE.DirectionalLight('#fff6ec', 4);
  readonly hemi = new THREE.HemisphereLight('#eef3f8', '#d8d0c4', 1);
  readonly ground: THREE.Mesh;
  readonly sky: SkyMesh;
  /** The camera the scene pass renders with; copies the active perspective camera each frame. */
  readonly viewCam = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
  readonly isWebGPU: boolean;
  readonly lite: boolean;
  camera: THREE.Camera;
  /** Which light set is drawn; follows the time of day (see SWITCH_ELEVATION). */
  preset: LightPreset = 'day';
  /** Sun elevation in degrees at the current time of day. */
  elevation = 40;
  /** Brightness of the room lamps, 0..1; the viewer applies it to the house. */
  lamps = 0;
  /** Brightness of the window spots, 0..1. */
  skylight = 1;
  /** Darkness of the house shadow on the ground in full sun; it fades with the sun. */
  groundShadow = 0.28;
  /** World box the sun's shadow must cover; set to the house. */
  readonly bounds = new THREE.Box3();
  /** Plan north, degrees clockwise from the top of the plan (see Plan.north). */
  north = 0;
  /** Frames per second the resolution controller aims for; follows the display refresh. */
  targetFps = 60;

  private pipeline: THREE.RenderPipeline;
  private planPipeline: THREE.RenderPipeline | null = null;
  private scenePass: ReturnType<typeof pass>;
  private gtao: ReturnType<typeof ao>;
  private settled = false;
  private lastChange = 0;
  private planCam: THREE.OrthographicCamera | null = null;
  /**
   * One light registry per preset. three keys every compiled material on the set of visible
   * lights, so flipping lamps on and off through one registry rebuilt every shader.
   * Each registry only ever sees its own preset's lights, so both sets stay compiled.
   */
  private lightings: Record<LightPreset, THREE.Lighting> = { day: new THREE.Lighting(), evening: new THREE.Lighting() };
  private outputKey = '';
  private background: string | null = null;
  private nightBackground: string | null = null;
  private mix = lightMix(40);
  /** The sun moved while it was down; its shadow map renders once it is up again. */
  private shadowStale = false;
  /** The HDRI sky fills `skyBox` (walk-mode windows). */
  private hdri = false;
  /** The HDRI's lighting copy fills `env`; the sky may still be loading, or skipped on phones. */
  private hdriLight = false;
  private hdriUrl: string | undefined;
  private pmrem: THREE.PMREMGenerator;
  private env: THREE.RenderTarget;
  /** Sky seen through the windows in walk mode; null on phones, which load only the lighting copy. */
  private skyBox: THREE.CubeRenderTarget | null;
  private center = new THREE.Vector3();
  private flat = false;

  // Internal render resolution as a fraction of the drawing buffer, stepped by adaptResolution.
  private readonly scales: number[];
  private scaleIndex: number;
  private frameTimes: number[] = [];
  private lastFrame = 0;
  private lockUntil = 0;
  private rafTimes: number[] = [];
  private lastRaf = 0;

  // Render on demand: frames still owed after a change, and the view last drawn.
  private owed = 2;
  private lastCam: THREE.Camera | null = null;
  private lastView = new THREE.Matrix4();
  private lastProj = new THREE.Matrix4();

  get hasEnvironment() {
    return this.hdri;
  }

  static async create(host: HTMLElement, opts: StageOptions = {}) {
    const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: opts.forceWebGL ?? false });
    await renderer.init();
    return new Stage(host, renderer, opts.lite ?? false);
  }

  private constructor(host: HTMLElement, r: THREE.WebGPURenderer, lite: boolean) {
    this.renderer = r;
    this.lite = lite;
    this.isWebGPU = (r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    this.camera = this.viewCam;
    this.scales = [0.6, 0.7, 0.8, 0.9, 1];
    this.scaleIndex = this.scales.length - 1;
    // Desktop stills retain Retina detail; phones keep their bounded drawing buffer.
    r.setPixelRatio(Math.min(window.devicePixelRatio, lite ? 1.25 : 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral keeps finishes at their real color and rolls off only the brightest highlights.
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.domElement.style.display = 'block';
    r.domElement.style.touchAction = 'none';
    host.appendChild(r.domElement);

    this.labels = new CSS2DRenderer();
    // CSS2DRenderer gives every label a z-index by depth; isolation keeps them under the page's overlays.
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', isolation: 'isolate' });
    host.appendChild(this.labels.domElement);

    // A soft studio environment fills and reflects until the HDRI sky arrives. The HDRI then
    // renders into this same target: a new environment texture would give every material a
    // new cache key and recompile them all while someone is looking around.
    this.pmrem = new THREE.PMREMGenerator(r);
    this.env = this.pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size: lite ? 256 : ENV_SIZE });
    this.scene.environment = this.env.texture;
    this.skyBox = lite ? null : new THREE.CubeRenderTarget(1024, { type: THREE.HalfFloatType });

    this.sky = new SkyMesh();
    this.sky.scale.setScalar(4000);
    this.sky.turbidity.value = 6;
    this.sky.rayleigh.value = 1.4;
    this.sky.mieCoefficient.value = 0.004;
    this.sky.mieDirectionalG.value = 0.8;
    this.sky.sunPosition.value.copy(SUN_DIR);
    this.scene.add(this.sky);

    this.sun.castShadow = true;
    // The shadow box is fitted to the house and its shadow on the lawn (fitShadow), so 4K
    // gives a few millimetres per texel; the tent filter softens the edge over a few centimetres.
    const map = lite ? 2048 : 4096;
    this.sun.shadow.mapSize.set(map, map);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 2;
    (this.sun.shadow as THREE.LightShadow & { filterNode?: unknown }).filterNode = tentShadow;
    // The house never moves, so the shadow map renders only when the sun, cut or plan changes.
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    // Shadow only: the house's shadow falls on the paper without a visible lawn disc.
    const groundMat = new THREE.ShadowNodeMaterial({ opacity: 0.28 });
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(80, 64), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.3;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.pipeline = new THREE.RenderPipeline(r);
    const cam = this.viewCam;
    this.scenePass = pass(this.scene, cam);
    this.scenePass.name = 'scene';
    this.scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView) }));
    this.scenePass.getTexture('normal').type = THREE.UnsignedByteType;
    const depth = this.scenePass.getTextureNode('depth');
    const normal = sample((uv) => unpackRGBToNormal(this.scenePass.getTextureNode('normal').sample(uv)));
    const gtao = ao(depth, normal, cam);
    this.gtao = gtao;
    gtao.resolutionScale = 0.5;
    gtao.radius.value = 0.35;
    gtao.thickness.value = 0.5;
    gtao.samples.value = lite ? 8 : 12;
    // GTAO's per-pixel noise pattern needs a temporal filter or a spatial one; this edge-aware
    // blur keeps the image stable when the camera stops, which render on demand relies on.
    const aoClean = denoise(gtao.getTextureNode(), depth, normal, cam);
    aoClean.radius.value = 4;
    const contact = mix(float(1), (aoClean as unknown as THREE.TextureNode).r, 0.85);
    const lit = this.scenePass.getTextureNode('output').rgb.mul(contact);
    this.pipeline.outputNode = smaa(renderOutput(vec4(lit, 1)));
    this.pipeline.outputColorTransform = false;
    this.applyLight();
  }

  /** Points the pipeline at a camera. The plan's orthographic camera gets a plain pass. */
  setCamera(camera: THREE.Camera) {
    const ortho = camera as THREE.OrthographicCamera;
    if (ortho.isOrthographicCamera && this.planCam !== ortho) {
      this.planCam = ortho;
      // A pipeline of its own: swapping one pipeline's output node rebuilt the whole post chain.
      this.planPipeline?.dispose();
      this.planPipeline = new THREE.RenderPipeline(this.renderer);
      this.planPipeline.outputNode = smaa(renderOutput(pass(this.scene, ortho)));
      this.planPipeline.outputColorTransform = false;
    }
    this.camera = camera;
    this.syncOutput();
    this.requestRender();
  }

  private syncOutput() {
    const key = (this.camera as THREE.OrthographicCamera).isOrthographicCamera ? 'plan' : 'real';
    if (key === this.outputKey) return;
    this.outputKey = key;
    this.setFlat(key === 'plan');
  }

  /** Sets the internal render scale (fraction of the drawing buffer). */
  setRenderScale(k: number) {
    this.scenePass.setResolutionScale(k);
    this.requestRender();
  }

  get renderScale() {
    return this.settled || this.outputKey === 'plan' ? 1 : this.scales[this.scaleIndex];
  }

  /**
   * Dynamic resolution: every ~40 drawn frames, compare the median frame time with the target.
   * Too slow: drop a step. Comfortably at the target: try a step up, and if that misses,
   * come back down and stay there for 8 s so the image does not pump.
   */
  private adaptResolution(now: number) {
    if (this.lastFrame) this.frameTimes.push(now - this.lastFrame);
    this.lastFrame = now;
    if (this.frameTimes.length < 40) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frameTimes.length = 0;
    const budget = 1000 / this.targetFps;
    let next = this.scaleIndex;
    if (median > budget * 1.12 && next > 0) {
      next--;
      this.lockUntil = now + 8000;
    } else if (median < budget * 1.04 && now > this.lockUntil && next < this.scales.length - 1) next++;
    if (next !== this.scaleIndex) {
      this.scaleIndex = next;
      this.setRenderScale(this.scales[next]);
    }
  }

  /**
   * Display refresh from idle animation frames (no drawing, so nothing slows them), snapped to a
   * common rate. A 120 Hz screen gets a 120 fps target; slow drawn frames never count, so they cannot lower it.
   */
  noteIdleFrame(now: number) {
    if (this.lastRaf && now - this.lastRaf < 50) this.rafTimes.push(now - this.lastRaf);
    this.lastRaf = now;
    if (this.rafTimes.length < 30) return;
    const sorted = this.rafTimes.sort((a, b) => a - b);
    const hz = 1000 / sorted[sorted.length >> 1];
    this.rafTimes = [];
    const snapped = REFRESH_RATES.reduce((best, r) => (Math.abs(r - hz) < Math.abs(best - hz) ? r : best), 60);
    this.targetFps = snapped;
  }

  /** Asks for fresh frames after a change the camera check cannot see. */
  requestRender(frames = 2) {
    this.owed = Math.max(this.owed, frames);
  }

  /**
   * Re-renders the sun's cached shadow map after the cut moves or the roof comes or goes.
   * Lamp shadows render once with full walls, so each room keeps its own light in the cutaway
   * too, and the six cube maps never cost a frame after load.
   */
  invalidateShadows() {
    this.sun.shadow.needsUpdate = true;
    this.requestRender();
  }

  /**
   * Lights and reflects with the HDRI's small, sun-clipped copy, then (with `sky`) loads the full
   * sky for the window view. Turns the sky so its sun comes from the garden side at the front-left
   * of the default dollhouse view, where the camera can see the shadows.
   */
  async setEnvironment(set: HdriSet | undefined, opts: { sky?: boolean; manager?: THREE.LoadingManager } = {}) {
    if (!set || set.env === this.hdriUrl) return;
    this.hdriUrl = set.env;
    const loader = new HDRLoader(opts.manager).setDataType(THREE.HalfFloatType);
    try {
      const env = await loader.loadAsync(set.env);
      if (!this.renderer.domElement.isConnected) return env.dispose();
      env.mapping = THREE.EquirectangularReflectionMapping;
      // Prefiltered into the existing target: a new environment texture would give every material
      // a new cache key and recompile them all while someone is looking around.
      this.pmrem.fromEquirectangular(env, this.env);
      env.dispose();
      const turn = Math.atan2(SUN_HOME.z, SUN_HOME.x) - Math.atan2(set.sun[2], set.sun[0]);
      // three applies environment rotation to the lookup direction, so the sky turns the other way.
      this.scene.environmentRotation.set(0, turn, 0);
      this.scene.backgroundRotation.set(0, turn, 0);
      this.hdriLight = true;
      this.applyLight();
      if (!opts.sky || !this.skyBox) return;
      const sky = await loader.loadAsync(set.sky);
      if (!this.renderer.domElement.isConnected) return sky.dispose();
      sky.mapping = THREE.EquirectangularReflectionMapping;
      // Filled in place like the environment; an equirect background would also convert
      // itself to a cube map mid-frame on the first walk and recompile that pass.
      this.skyBox.fromEquirectangularTexture(this.renderer, sky);
      sky.dispose();
      this.hdri = true;
      this.applyLight();
    } catch (e) {
      console.warn('HDRI failed to load; keeping the procedural sky', e);
      this.hdri = false;
    }
  }

  private placeSun() {
    const { x: cx, z: cz } = this.center;
    this.sun.position.set(cx + SUN_DIR.x * 30, SUN_DIR.y * 30, cz + SUN_DIR.z * 30);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.fitShadow();
    // A 4K shadow pass per slider step buys nothing while the sun is down.
    if (this.sun.intensity > 0) this.sun.shadow.needsUpdate = true;
    else this.shadowStale = true;
    this.requestRender();
  }

  /**
   * Fits the sun's shadow camera to the house box plus the shadow it throws on the ground, in
   * light space. A loose box around the whole site wasted most of the map on empty lawn.
   */
  private fitShadow() {
    if (this.bounds.isEmpty()) return;
    const cam = this.sun.shadow.camera;
    const view = new THREE.Matrix4().lookAt(this.sun.position, this.sun.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(this.sun.position);
    view.invert();
    const b = this.bounds;
    const dir = SUN_DIR.clone();
    // Long evening shadows are clipped at 12 m; past that they fall off the lawn anyway.
    const reach = Math.min(12, (b.max.y - this.ground.position.y) / Math.max(0.08, dir.y));
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      box.expandByPoint(p.clone().applyMatrix4(view));
      const along = Math.min(reach, (p.y - this.ground.position.y) / Math.max(0.08, dir.y));
      box.expandByPoint(p.addScaledVector(dir, -along).applyMatrix4(view));
    }
    const pad = 0.3;
    cam.left = box.min.x - pad;
    cam.right = box.max.x + pad;
    cam.bottom = box.min.y - pad;
    cam.top = box.max.y + pad;
    cam.near = Math.max(0.1, -box.max.z - 1);
    cam.far = -box.min.z + 1;
    cam.updateProjectionMatrix();
  }

  /**
   * Time of day over 24 hours, t = 0..1 for 00:00..24:00: the sun rises in the east, stands in
   * the south at noon and sets in the west, with the compass turned to the plan's `north`.
   * Night, dusk and day blend by intensity and colour only, so no shader changes along the way.
   * Moves the sun light; the HDRI sky stays put.
   */
  setTimeOfDay(t: number) {
    t = THREE.MathUtils.clamp(t, 0, 1);
    const deg = sunElevation(t);
    this.elevation = deg;
    this.mix = lightMix(deg);
    this.preset = deg < SWITCH_ELEVATION ? 'evening' : 'day';
    this.lamps = this.mix.lamps;
    this.skylight = this.mix.skylight;
    // Plan +x is east and plan +y (world +z) is south: the sun swings east → south → west.
    const az = Math.PI * ((t * 24 - SUNRISE) / (SUNSET - SUNRISE));
    const turn = -THREE.MathUtils.degToRad(this.north);
    const at = (el: number, v: THREE.Vector3) =>
      v.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).applyAxisAngle(UP, turn);
    // The procedural sky gets the true sun and darkens below the horizon.
    at(THREE.MathUtils.degToRad(deg), this.sky.sunPosition.value);
    at(THREE.MathUtils.degToRad(Math.max(3, deg)), SUN_DIR);
    // Whites stay white by day; only the last hour before sunset turns golden.
    this.sun.color.lerpColors(NOON_SUN, LOW_SUN, this.mix.golden ** 2);
    this.applyLight();
    this.placeSun();
  }

  /** Centers the sun on the house and fits its shadow to `box`. */
  fitSun(box: THREE.Box3) {
    box.getCenter(this.center).setY(0);
    this.bounds.copy(box);
    this.ground.position.x = this.center.x;
    this.ground.position.z = this.center.z;
    this.placeSun();
    this.invalidateShadows();
  }

  /** Even, shadow-free light for the plan view, where sun shadows would hide the drawing. */
  setFlat(on: boolean) {
    if (on === this.flat) return;
    this.flat = on;
    this.applyLight();
  }

  private applyLight() {
    const { sun, day } = this.mix;
    if (this.flat) {
      // Intensity, not castShadow: flipping castShadow at runtime breaks WebGPU's shadow node.
      this.sun.intensity = 0;
      this.hemi.intensity = 2.2;
      this.hemi.color.set('#ffffff');
      this.hemi.groundColor.set('#ffffff');
      this.scene.environmentIntensity = 0.6;
      this.renderer.toneMappingExposure = 1;
    } else {
      const overview = this.background !== null;
      // Low sun is weaker as well as warmer, and fades out a moment before it touches the horizon.
      // With the roof cut away, direct sun reaches every room. Use softer daylight in the overview
      // so pale floors and fabrics retain their colour and shading instead of rolling into white.
      this.sun.intensity = (overview ? 2.2 : 4) * (0.45 + 0.55 * Math.min(1, Math.sin(THREE.MathUtils.degToRad(this.elevation)) * 2)) * sun;
      // No bounce light is simulated: by day a white sky hemisphere over a near-neutral floor bounce and the
      // environment lift every shaded surface to a soft, bright base; GTAO darkens creases and contact.
      // The lawn in the HDRI already warms the bounce, so the hemisphere's ground stays almost grey.
      this.hemi.color.lerpColors(NIGHT_HEMI.sky, DAY_HEMI.sky, day);
      this.hemi.groundColor.lerpColors(NIGHT_HEMI.ground, DAY_HEMI.ground, day);
      this.hemi.intensity = THREE.MathUtils.lerp(NIGHT_HEMI.intensity, overview ? 1.25 : DAY_HEMI.intensity, day);
      this.scene.environmentIntensity = THREE.MathUtils.lerp(0.05, (this.hdriLight ? 0.35 : 0.6) * (overview ? 0.7 : 1), day);
      // Interiors are exposed for the room, like interior photography; the overviews get sun everywhere.
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(1.15, overview ? 0.85 : 1.1, day);
    }
    // The shadow-only ground ignores light intensity, so it would keep a set sun's shadow all night.
    (this.ground.material as THREE.Material).opacity = this.groundShadow * (this.flat ? 1 : sun);
    if (this.shadowStale && this.sun.intensity > 0) {
      this.shadowStale = false;
      this.sun.shadow.needsUpdate = true;
    }
    this.applyBackground();
    this.requestRender();
  }

  /**
   * A flat color behind the dollhouse and plan; null shows the sky (walk mode). The overviews
   * fade to `night` after dark, so the lit rooms read as evening; the plan stays on paper.
   */
  setBackground(color: string | null, night: string | null = color) {
    this.background = color;
    this.nightBackground = night;
    this.applyLight();
  }

  private applyBackground() {
    const { day } = this.mix;
    let bg: THREE.Color | null = null;
    // Below this the sky texture is too dim to tell from the flat night sky that replaces it.
    const darkSky = day < 0.05;
    if (this.background) {
      const paper = new THREE.Color(this.background);
      if (!this.flat && this.nightBackground) paper.lerp(new THREE.Color(this.nightBackground), 1 - day);
      bg = untonemapped(`#${paper.getHexString()}`, this.renderer.toneMappingExposure);
    } else if (darkSky) bg = new THREE.Color(NIGHT_SKY);
    // The sky box stays the walk background even before the HDRI fills it (the procedural sky
    // covers it until then), so its shaders compile with everything else at load.
    this.scene.background = bg ?? this.skyBox?.texture ?? null;
    this.scene.backgroundIntensity = 0.6 * Math.max(day, 0.05);
    this.sky.visible = !this.background && !darkSky && !this.hdri;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.labels.setSize(w, h);
    this.viewCam.aspect = w / h;
    this.viewCam.updateProjectionMatrix();
    this.requestRender();
  }

  /** Copies the active perspective camera into viewCam. */
  private syncViewCam() {
    const c = this.camera as THREE.PerspectiveCamera;
    if (!c.isPerspectiveCamera || c === this.viewCam) return;
    this.viewCam.copy(c, false);
    this.viewCam.updateProjectionMatrix();
    this.viewCam.updateMatrixWorld();
  }

  /** True when the camera moved or something asked for a frame since the last draw. */
  private viewChanged() {
    const c = this.camera;
    c.updateMatrixWorld();
    // The walker's collision step leaves ~1e-16 m of jitter on a still camera; that is not motion.
    const moved = c !== this.lastCam || !near(c.matrixWorld, this.lastView) || !near(c.projectionMatrix, this.lastProj);
    if (moved) {
      this.lastCam = c;
      this.lastView.copy(c.matrixWorld);
      this.lastProj.copy(c.projectionMatrix);
    }
    return moved;
  }

  /**
   * Draws a frame only when the view changed or a frame is owed. Called every animation frame;
   * a still camera costs nothing but this check. Returns whether it drew.
   */
  renderIfNeeded(now = performance.now()) {
    if (!this.viewChanged() && this.owed <= 0) {
      this.lastFrame = 0;
      if (this.settled || this.outputKey !== 'real' || now - this.lastChange < 120) {
        this.noteIdleFrame(now);
        return false;
      }
      // Brief input gaps during a drag stay cheap. After quiet, replace the last moving frame once.
      this.settled = true;
      this.lastRaf = 0;
      this.scenePass.setResolutionScale(1);
      this.gtao.resolutionScale = 1;
      this.draw(true);
      return true;
    }
    this.lastChange = now;
    if (this.settled) {
      this.settled = false;
      this.scenePass.setResolutionScale(this.scales[this.scaleIndex]);
      this.gtao.resolutionScale = 0.5;
    }
    this.lastRaf = 0;
    this.owed = Math.max(0, this.owed - 1);
    this.render(now);
    return true;
  }

  /**
   * Compiles the scene pass's pipelines without drawing, one object per task, so the first frame
   * finds them ready. `onProgress` gets the compiled fraction.
   */
  async compile(onProgress?: (done: number) => void) {
    const r = this.renderer;
    this.syncViewCam();
    r.lighting = this.lightings[this.preset];
    const target = r.getRenderTarget();
    const mrt = r.getMRT();
    // The pass's target, MRT and render context are part of each pipeline's cache key, through the
    // context's clipping id. three keys render contexts by call depth, and the scene pass draws
    // nested in the post chain (SCENE_PASS_DEPTH); compileAsync always asks for depth 0, which
    // compiled a second, unused set. If the chain changes, the compile misses and the first draw compiles.
    const contexts = (r as unknown as { _renderContexts: { get(t: unknown, m: unknown, depth?: number): unknown } })._renderContexts;
    const get = contexts.get;
    contexts.get = (t, m) => get.call(contexts, t, m, SCENE_PASS_DEPTH);
    r.setRenderTarget(this.scenePass.renderTarget);
    r.setMRT(this.scenePass.getMRT());
    try {
      let done: Promise<void>;
      try {
        // compileAsync takes its render context before its first await; the materials build later
        // and read the MRT then, so the target stays bound until it finishes.
        done = r.compileAsync(this.scene, this.viewCam, null, (e: ProgressEvent) => onProgress?.(e.loaded / Math.max(1, e.total)));
      } finally {
        contexts.get = get;
      }
      await done;
    } finally {
      r.setRenderTarget(target);
      r.setMRT(mrt);
    }
  }

  render(now = performance.now()) {
    if (this.outputKey === 'real') this.adaptResolution(now);
    else this.lastFrame = 0;
    this.draw(true);
  }

  /**
   * Draws in a fresh three frame, outside the frame-rate controller. Warm-up draws a hidden state
   * this way, then redraws the real one in the same task, so the browser only presents the real one.
   */
  drawNow(labels = true) {
    // three runs each pass once per frame and counts frames per animation frame; a second draw
    // in the same task needs the next frame, or it would composite the hidden state's passes.
    (this.renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame.update();
    this.lastFrame = 0;
    this.draw(labels);
  }

  private draw(labels: boolean) {
    this.syncViewCam();
    this.renderer.lighting = this.lightings[this.preset];
    (this.outputKey === 'plan' && this.planPipeline ? this.planPipeline : this.pipeline).render();
    if (labels) this.labels.render(this.scene, this.camera);
  }

  dispose() {
    this.pipeline.dispose();
    this.planPipeline?.dispose();
    this.skyBox?.dispose();
    this.env.dispose();
    this.pmrem.dispose();
    const all: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      all.push(o);
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    // three keeps a few module-level references to the last renderer's lights and passes. Taking
    // the graph apart means such a reference holds one small object, not the whole house.
    for (const o of all) o.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
