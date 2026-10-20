import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as plan from './plan.js';
import * as lib from './lib.js';
import { buildWalls, buildSlabs, openingRect } from './shell.js';

const params = new URLSearchParams(location.search);
const SHOT = params.has('shot');
const errors = [];
window.__errors = errors;
window.__ready = false;
window.__archHealth = { status: 'loading', errors, templateVersion: '0.1.0' };
function failPreview(message) {
  errors.push(message);
  window.__ready = false;
  window.__archHealth.status = 'error';
  const ui = document.getElementById('ui');
  if (ui) {
    ui.classList.remove('hidden');
    const title = ui.querySelector('h1');
    if (title) title.textContent = 'Preview incomplete';
    const description = ui.querySelector('p');
    if (description) description.textContent = message;
    const button = document.getElementById('enter');
    if (button) { button.disabled = true; button.textContent = 'Resolve preview errors'; }
  }
}
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };
window.addEventListener('error', (e) => failPreview(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => failPreview(String(e.reason)));

// Project inputs are required; the template does not choose a house or its assets.
const { presentation } = plan;
document.title = `${presentation.title} · walkthrough`;
document.querySelector('#ui h1').textContent = presentation.title;
document.querySelector('#ui p').textContent = presentation.description;

// Painted textures read their pixels back and some use blur filters; on GPU-backed canvases
// that work competes with WebGL and has reset the context. Keep every 2D canvas on the CPU.
const getContext2d = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, opts) {
  return getContext2d.call(this, type, type === '2d' ? { willReadFrequently: true, ...opts } : opts);
};

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: SHOT });
// ?hq renders at up to 1.5x on high-DPI screens; the default favours a smooth frame rate.
renderer.setPixelRatio(SHOT || !params.has('hq') ? 1 : Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// Sun and house never move: render the shadow map once instead of every frame.
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost', () => failPreview('WebGL context lost. Reload and verify this version again.'));
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 400);
camera.position.set(...presentation.start.position);
camera.lookAt(...presentation.start.target);

// ---------- sky + sun ----------
const pmrem = new THREE.PMREMGenerator(renderer);
let skyEnv = null;
lib.track(new HDRLoader().loadAsync(presentation.environment).then((t) => {
  t.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = t;
  skyEnv = pmrem.fromEquirectangular(t).texture;
  scene.environment = skyEnv;
}));
const SKY_ENV_INTENSITY = 0.8;
const ROOM_ENV_INTENSITY = 1.0;
scene.environmentIntensity = SKY_ENV_INTENSITY;
scene.backgroundIntensity = 1.0;

const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
const sunDir = new THREE.Vector3(0.55, 0.62, 0.56).normalize(); // south-east, ~38 deg up (late morning)
sun.position.copy(sunDir).multiplyScalar(40).add(new THREE.Vector3(...presentation.sunTarget));
sun.target.position.set(...presentation.sunTarget);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 90 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.025;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x9c8160, 0.25);
scene.add(hemi);

// ---------- light slots (fixed light count => no shader recompiles while walking) ----------
const lampSpecs = [];
const lampSlots = Array.from({ length: 10 }, () => {
  const l = new THREE.PointLight(0xffffff, 0, 1, 2);
  scene.add(l);
  return l;
});
const windowSpecs = [];
// Window panels are the costliest lights per pixel: keep 5 for screenshots, the nearest 2 while walking.
const windowSlots = Array.from({ length: SHOT ? 5 : 2 }, () => {
  const l = new THREE.RectAreaLight(0xffffff, 0, 1, 1);
  scene.add(l);
  return l;
});
let lastAssign = null;
function assignLights(force = false) {
  const p = camera.position;
  if (!force && lastAssign && lastAssign.distanceTo(p) < 0.3) return;
  lastAssign = p.clone();
  const here = plan.roomAt(p.x, p.z);
  const score = (s) => Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z) + (s.rooms.includes(here) ? 0 : 4);
  const pick = (specs, slots, apply) => {
    const best = specs.slice().sort((a, b) => score(a) - score(b)).slice(0, slots.length);
    slots.forEach((l, i) => (best[i] ? apply(l, best[i]) : (l.intensity = 0)));
  };
  pick(lampSpecs, lampSlots, (l, s) => {
    l.position.set(s.x, s.y, s.z);
    l.color.set(s.color);
    l.intensity = s.intensity;
    l.distance = s.distance;
  });
  pick(windowSpecs, windowSlots, (l, s) => {
    l.position.set(s.x, s.y, s.z);
    l.width = s.width;
    l.height = s.height;
    l.color.set(s.color);
    l.intensity = s.intensity;
    l.lookAt(s.x + s.nx, s.y, s.z + s.nz);
  });
}

// daylight panel at every window and glazed door, facing into the room
for (const o of plan.openings) {
  if (!(o.type === 'window' || o.glazed) || !o.wall) continue;
  const r = openingRect(o);
  const inward = o.wall.startsWith('n_') || o.wall.startsWith('w_') ? 1 : -1;
  const along = r.axis;
  const w = o.a1 - o.a0, h = o.y1 - o.y0;
  const c = (o.a0 + o.a1) / 2, cy = (o.y0 + o.y1) / 2;
  const face = inward > 0 ? (along === 'x' ? r.z1 : r.x1) + 0.02 : (along === 'x' ? r.z0 : r.x0) - 0.02;
  windowSpecs.push({
    x: along === 'x' ? c : face, y: cy, z: along === 'x' ? face : c,
    nx: along === 'x' ? 0 : inward, nz: along === 'x' ? inward : 0,
    id: o.id, width: w, height: h, color: 0xe8f0ff, intensity: 2.2, rooms: o.rooms,
  });
}

// ---------- context for room modules ----------
const colliders = [];
const ctx = {
  THREE, scene, plan, ...lib,
  H: plan.H, GROUND: plan.GROUND, rooms: plan.rooms,
  FLOOR_Y: 0.005, // put finished floor surfaces here (1 cm above the structural slab top at 0)
  group: null,
  addCollider: (x0, z0, x1, z1) => colliders.push({ x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) }),
  /** Register a lamp. Rendered by the nearest-lamps slot pool (10 live point lights). */
  light: ({ x, y, z, color = 0xffd7a8, intensity = 2, distance = 5, rooms }) => {
    const r = rooms ?? [plan.roomAt(x, z)];
    lampSpecs.push({ x, y, z, color, intensity, distance, rooms: r });
  },
  /** Adjust the automatic daylight panel for a window/glazed door opening id. */
  daylight: (openingId, { intensity, color } = {}) => {
    for (const s of windowSpecs.filter((v) => v.id === openingId)) {
      if (intensity !== undefined) s.intensity = intensity;
      if (color !== undefined) s.color = color;
    }
  },
};

const defaultPlaster = lib.pbr(presentation.materials.plaster.id, presentation.materials.plaster.options);
const defaultStucco = lib.pbr(presentation.materials.stucco.id, presentation.materials.stucco.options);
const defaultFloor = lib.pbr(presentation.materials.floor.id, presentation.materials.floor.options);

async function loadPiece(path, name) {
  try {
    const mod = await import(path);
    const group = new THREE.Group();
    group.name = name;
    scene.add(group);
    return { name, mod, group };
  } catch (e) {
    console.error(`[${name}] failed to load: ${e.stack || e}`);
    return null;
  }
}

async function buildPiece(p) {
  if (!p?.mod.build) { console.error(`[${p?.name ?? 'unknown'}] missing build export`); return; }
  try {
    await p.mod.build({ ...ctx, group: p.group });
  } catch (e) {
    console.error(`[${p.name}] build failed: ${e.stack || e}`);
  }
}

async function init() {
  // ?skip=bath,doors leaves pieces out (debugging)
  const skip = new Set((params.get('skip') || '').split(',').filter(Boolean));
  if (skip.size) console.error('Debug preview skips pieces; this is not a complete project.');
  const pieces = (await Promise.all(plan.pieces.filter((n) => !skip.has(n)).map((n) => loadPiece(`./rooms/${n}.js`, n)))).filter(Boolean);
  const parts = (await Promise.all(plan.parts.filter((n) => !skip.has(n)).map((n) => loadPiece(`./parts/${n}.js`, `part:${n}`)))).filter(Boolean);
  const byName = Object.fromEntries(pieces.map((p) => [p.name, p]));

  const wallMats = new Map();
  const materialFor = (surface) => {
    if (wallMats.has(surface)) return wallMats.get(surface);
    let m = null;
    const owner = surface === 'exterior' ? 'exterior' : plan.rooms[surface]?.owner;
    const p = owner && byName[owner];
    if (p?.mod.wallMaterial && surface !== 'reveal') {
      try { m = p.mod.wallMaterial({ ...ctx, group: p.group }, surface); } catch (e) { console.error(`[${owner}] wallMaterial: ${e}`); }
    }
    m ??= surface === 'exterior' ? defaultStucco : defaultPlaster;
    wallMats.set(surface, m);
    return m;
  };
  const { group: wallGroup, colliders: wallCols } = buildWalls(materialFor);
  scene.add(wallGroup, buildSlabs(defaultFloor, defaultPlaster));
  colliders.push(...wallCols);

  // default ground (the exterior piece covers it with its own landscape)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x8c7a5c, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = plan.GROUND - 0.01;
  ground.receiveShadow = true;
  ground.name = 'default-ground';
  scene.add(ground);

  await Promise.all([...pieces, ...parts].map(buildPiece));
  await lib.allLoaded();
  limitTextureSizes();
  freezeMirrors();
  mergeStaticMeshes();
  renderer.shadowMap.needsUpdate = true;
  await bakeRoomProbes();
  assignLights(true);
}

// ---------- mirrors ----------
// A three.js Reflector re-renders the whole house every frame whenever it is inside the view
// cone, even behind walls. With four of them the walkthrough ran at a few frames per second.
// Swap each for a polished metal surface that reflects the room's bounce-light probe.
function freezeMirrors() {
  scene.traverse((o) => {
    if (!o.isReflector) return;
    o.onBeforeRender = () => {};
    o.getRenderTarget?.().dispose();
    o.material.dispose();
    o.material = new THREE.MeshStandardMaterial({ color: 0xd9d6cf, metalness: 1, roughness: 0.035 });
  });
}

// ---------- draw-call merge ----------
// Pieces are built from thousands of small meshes, and nothing moves after load. Merge each
// piece's opaque meshes that share a material into one mesh, cutting draw calls several-fold.
function mergeStaticMeshes() {
  const plainHook = THREE.Object3D.prototype.onBeforeRender;
  const inv = new THREE.Matrix4();
  const rel = new THREE.Matrix4();
  for (const group of scene.children.filter((c) => c.isGroup)) {
    group.updateMatrixWorld(true);
    inv.copy(group.matrixWorld).invert();
    const buckets = new Map();
    group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material)) return;
      const g = o.geometry;
      if (o.material.transparent || o.onBeforeRender !== plainHook || g.morphAttributes.position) return;
      if (o.matrixWorld.determinant() <= 0) return;
      for (let p = o; p; p = p.parent) if (!p.visible) return;
      const attrs = Object.entries(g.attributes);
      if (attrs.some(([, a]) => a.isInterleavedBufferAttribute)) return;
      const key = [o.material.uuid, o.castShadow, o.receiveShadow, o.renderOrder, g.index ? 'i' : 'n',
        attrs.map(([k, a]) => `${k}:${a.itemSize}:${a.array.constructor.name}:${a.normalized}`).sort().join(',')].join('|');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(o);
    });
    for (const meshes of buckets.values()) {
      if (meshes.length < 2) continue;
      const geos = meshes.map((o) => o.geometry.clone().applyMatrix4(rel.multiplyMatrices(inv, o.matrixWorld)));
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const first = meshes[0];
      const m = new THREE.Mesh(merged, first.material);
      m.castShadow = first.castShadow;
      m.receiveShadow = first.receiveShadow;
      m.renderOrder = first.renderOrder;
      m.name = `${group.name}:merged`;
      meshes.forEach((o) => o.removeFromParent());
      group.add(m);
    }
  }
}

// ---------- texture budget ----------
// Builders load ~360 textures. At full size they need well over 1 GB of GPU memory, which
// gets the browser tab killed. Downscale before upload: surface colour maps keep 1024 px,
// everything else (normal/roughness maps, model textures, small painted textures) 512 px.
function limitTextureSizes() {
  const done = new Set();
  const shrink = (tex, max) => {
    const src = tex.source;
    const img = src?.data;
    if (!img || done.has(src) || !(img.width > max || img.height > max)) return;
    done.add(src);
    const k = max / Math.max(img.width, img.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    src.data = c;
    src.needsUpdate = true;
  };
  scene.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const [key, tex] of Object.entries(m)) {
        if (!tex?.isTexture || tex.isRenderTargetTexture || tex.isDataTexture || tex.isCompressedTexture) continue;
        const img = tex.source?.data;
        const fromModel = typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap;
        shrink(tex, key === 'map' && !fromModel ? 1024 : 512);
      }
    }
  });
}

// ---------- per-room bounce light ----------
// Each interior room gets its own environment map rendered from inside it, so reflections
// and ambient light come from the room's actual walls, floor and windows instead of the open
// sky. Two passes = direct light plus one bounce.
const roomEnv = new Map();
async function bakeRoomProbes() {
  const rt = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
  const cube = new THREE.CubeCamera(0.05, 60, rt);
  scene.add(cube);
  const interior = Object.entries(plan.rooms).filter(([, r]) => !r.outdoor);
  const saved = camera.position.clone();
  for (let pass = 0; pass < 2; pass++) {
    const next = new Map();
    for (const [id, r] of interior) {
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      camera.position.set(cx, 1.4, cz);
      assignLights(true);
      scene.environment = pass === 0 ? null : roomEnv.get(id);
      scene.environmentIntensity = ROOM_ENV_INTENSITY;
      cube.position.set(cx, 1.4, cz);
      cube.update(renderer, scene);
      next.set(id, pmrem.fromCubemap(rt.texture).texture);
      await new Promise((r) => setTimeout(r)); // let the browser breathe between rooms
    }
    for (const [id, t] of next) { roomEnv.get(id)?.dispose(); roomEnv.set(id, t); }
  }
  scene.remove(cube);
  rt.dispose();
  camera.position.copy(saved);
  currentEnvRoom = undefined;
}

let currentEnvRoom;
function envRoomAt(p) {
  let id = plan.roomAt(p.x, p.z);
  if (id === null) {
    // standing in a doorway: use the nearest room
    let best = Infinity;
    for (const [rid, r] of Object.entries(plan.rooms)) {
      const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1), dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
      const d = Math.hypot(dx, dz);
      if (d < best) { best = d; id = rid; }
    }
    if (best > 0.6) id = null;
  }
  return id;
}
function updateEnvironment() {
  const id = envRoomAt(camera.position);
  if (id === currentEnvRoom) return;
  currentEnvRoom = id;
  const env = id && roomEnv.get(id);
  scene.environment = env || skyEnv;
  scene.environmentIntensity = env ? ROOM_ENV_INTENSITY : SKY_ENV_INTENSITY;
}

// ---------- composer ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.5, thickness: 1, scale: 1.2, samples: SHOT ? 16 : 8 });
gtao.blendIntensity = 0.85;
if (!SHOT) {
  // half-resolution ambient occlusion while walking
  const fullSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => fullSize(Math.ceil(w / 2), Math.ceil(h / 2));
}
composer.addPass(gtao);
composer.addPass(new OutputPass());
composer.setSize(innerWidth, innerHeight);

// ---------- views ----------
function applyView(id) {
  const v = plan.views[id];
  if (!v) return false;
  camera.position.set(...v.pos);
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  camera.lookAt(...v.target);
  assignLights(true);
  return true;
}

// ---------- walking ----------
const controls = new PointerLockControls(camera, document.body);
const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
const EYE = 1.62, RADIUS = 0.22;

function groundHeight(x, z) {
  for (const s of plan.steps) {
    if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) {
      const t = s.rise === 'north' ? (s.z1 - z) / (s.z1 - s.z0) : (s.x1 - x) / (s.x1 - s.x0);
      return plan.GROUND + (0 - plan.GROUND) * Math.min(1, Math.ceil(t * s.treads) / s.treads);
    }
  }
  const inHouse = x >= plan.EXT.x0 && x <= plan.EXT.x1 && z >= plan.EXT.z0 && z <= plan.EXT.z1;
  const r = plan.roomAt(x, z);
  if (inHouse || r === 'porch' || r === 'terrace') return 0;
  return plan.GROUND;
}

function blocked(x, z) {
  return colliders.some((c) => x > c.x0 - RADIUS && x < c.x1 + RADIUS && z > c.z0 - RADIUS && z < c.z1 + RADIUS);
}

const timer = new THREE.Timer();
function walk(dt) {
  if (!controls.isLocked) return;
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3.2 : 1.6) * dt;
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (f || s) {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = fwd.multiplyScalar(f).add(right.multiplyScalar(s)).normalize().multiplyScalar(speed);
    const p = camera.position;
    if (!blocked(p.x + move.x, p.z)) p.x += move.x;
    if (!blocked(p.x, p.z + move.z)) p.z += move.z;
  }
  const target = groundHeight(camera.position.x, camera.position.z) + EYE;
  camera.position.y += (target - camera.position.y) * Math.min(1, dt * 10);
  assignLights();
}

// ---------- UI ----------
function setupUI() {
  const ui = document.getElementById('ui');
  const sel = document.getElementById('goto');
  for (const [id, v] of Object.entries(plan.views)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${v.piece}: ${id}`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { applyView(sel.value); sel.blur(); });
  const enter = document.getElementById('enter');
  enter.disabled = false;
  enter.textContent = 'Walk in';
  enter.addEventListener('click', () => controls.lock());
  controls.addEventListener('lock', () => ui.classList.add('hidden'));
  controls.addEventListener('unlock', () => ui.classList.remove('hidden'));
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

init().then(async () => {
  const v = params.get('view');
  if (v && !applyView(v)) console.error(`Requested camera view is missing: ${v}`);
  if (!v) {
    camera.position.set(...presentation.start.position);
    camera.lookAt(...presentation.start.target);
  }
  if (!SHOT) setupUI();
  else document.getElementById('ui').remove();
  await renderer.compileAsync(scene, camera);
  let frames = 0;
  renderer.setAnimationLoop(() => {
    timer.update();
    walk(Math.min(timer.getDelta(), 0.05));
    updateEnvironment();
    composer.render();
    if (++frames === 4) {
      window.__ready = errors.length === 0;
      window.__archHealth.status = window.__ready ? 'ready' : 'error';
      if (errors.length) failPreview('Some project pieces or assets failed. Review runtime errors before acceptance.');
    }
  });
}).catch((error) => { console.error(error); failPreview(String(error)); });

window.__debug = { scene, camera, renderer, composer, plan, applyView };
