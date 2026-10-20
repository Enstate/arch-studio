// Shared helpers handed to every room module as `ctx`.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const pending = [];
const texCache = new Map();
const gltfCache = new Map();

export function track(promise) {
  pending.push(promise.catch((e) => console.error(e)));
  return promise;
}

export async function allLoaded() {
  // modules may queue more loads while earlier ones resolve
  let n = -1;
  while (n !== pending.length) {
    n = pending.length;
    await Promise.all(pending.slice());
  }
}

function texture(url, srgb) {
  const key = `${url}|${srgb}`;
  if (!texCache.has(key)) {
    texCache.set(key, track(new Promise((res, rej) => texLoader.load(url, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      res(t);
    }, undefined, () => rej(new Error(`texture failed: ${url}`))))));
  }
  return texCache.get(key);
}

/**
 * PBR material from assets/textures/<id>/ using texture files supplied by the project.
 * Geometry UVs are expected in metres (see worldUV / box); `size` is how many metres one
 * texture tile covers. `tint` multiplies the albedo; albedo:false keeps only the relief
 * (normal + roughness maps) over a flat `tint` colour. Returns a material immediately; maps
 * stream in and are counted for screenshot readiness.
 */
export function pbr(id, { size = 2, tint = 0xffffff, roughness = 1, normalScale = 1, rotation = 0, aoMap = false, albedo = true, ...rest } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: tint, roughness, ...rest });
  const base = `assets/textures/${id}`;
  const setup = (t) => {
    const c = t.clone();
    c.repeat.set(1 / size, 1 / size);
    c.rotation = rotation;
    c.needsUpdate = true;
    return c;
  };
  track(Promise.all([
    albedo ? texture(`${base}/diff.jpg`, true).then((t) => { mat.map = setup(t); }) : null,
    texture(`${base}/nor.jpg`, false).then((t) => { mat.normalMap = setup(t); mat.normalScale.set(normalScale, normalScale); }).catch(() => {}),
    texture(`${base}/rough.jpg`, false).then((t) => { mat.roughnessMap = setup(t); }).catch(() => {}),
    aoMap ? texture(`${base}/ao.jpg`, false).then((t) => { mat.aoMap = setup(t); }).catch(() => {}) : null,
  ]).then(() => { mat.needsUpdate = true; }));
  return mat;
}

/** Plain image texture (sRGB) for artwork, rugs, labels: assets/... path. */
export function image(url, { repeat = [1, 1] } = {}) {
  return texture(url, true).then((t) => {
    const c = t.clone();
    c.repeat.set(...repeat);
    c.needsUpdate = true;
    return c;
  });
}

/** Canvas texture drawn by `draw(ctx2d, w, h)`, for patterned textiles, tiles, art. */
export function canvasTexture(w, h, draw, { repeat = [1, 1], srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  // CPU-backed canvas: ~150 GPU-backed canvases competed with WebGL for GPU memory and reset the context
  draw(c.getContext('2d', { willReadFrequently: true }), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  return t;
}

/**
 * Loads assets/models/<id>/<id>.gltf from the project.
 * Resolves to a fresh clone with shadows enabled. Poly Haven models are in metres.
 */
export function gltf(id, url = `assets/models/${id}/${id}.gltf`) {
  if (!gltfCache.has(url)) {
    gltfCache.set(url, track(new Promise((res, rej) => gltfLoader.load(url, (g) => res(g.scene), undefined, rej))));
  }
  return track(gltfCache.get(url).then((src) => {
    const o = src.clone(true);
    o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    return o;
  }));
}

/** Rewrites UVs so 1 UV unit = 1 metre in world space (planar projection by face normal). */
export function worldUV(geometry) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny >= nx && ny >= nz) { uv[2 * i] = x; uv[2 * i + 1] = z; }
    else if (nx >= nz) { uv[2 * i] = z; uv[2 * i + 1] = y; }
    else { uv[2 * i] = x; uv[2 * i + 1] = y; }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** Box mesh centred at (x, y, z) with world-metre UVs. */
export function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  worldUV(g);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Box spanning plan rect [x0,x1]x[z0,z1] from height y0 to y1. */
export function slab(x0, z0, x1, z1, y0, y1, mat) {
  return box(x1 - x0, y1 - y0, z1 - z0, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** Scales `obj` uniformly so its bounding box matches one target dimension. */
export function fit(obj, { width, height, depth } = {}) {
  const s = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  const k = width ? width / s.x : height ? height / s.y : depth ? depth / s.z : 1;
  obj.scale.multiplyScalar(k);
  return obj;
}

/** Moves `obj` so its bounding box sits on y=floorY centred at (x, z). Call after rotation/scale. */
export function place(obj, x, z, floorY = 0) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  const c = b.getCenter(new THREE.Vector3());
  obj.position.x += x - c.x;
  obj.position.z += z - c.z;
  obj.position.y += floorY - b.min.y;
  return obj;
}
