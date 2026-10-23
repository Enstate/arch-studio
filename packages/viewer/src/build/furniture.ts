import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Plan, Furniture, FurnitureType } from '../plan/schema.ts';
import { FURNITURE_DEFAULT_SIZE } from '../plan/furnitureSizes.ts';
import type { MaterialLibrary } from './materials.ts';

type MatFn = (key: string) => THREE.Material;

/**
 * Each builder works in a local frame: width along x, depth along z,
 * front facing +z, footprint centered on the origin, floor at y = 0.
 */
type Builder = (s: { w: number; d: number; h: number }, m: THREE.Material, a: THREE.Material, mat: MatFn) => THREE.Object3D[];

const DEFAULT_MAT: Partial<Record<FurnitureType, [string, string]>> = {
  bed: ['linen', 'wood'],
  sofa: ['fabric', 'dark-wood'],
  armchair: ['fabric', 'dark-wood'],
  'kitchen-base': ['white', 'worktop'],
  'kitchen-tall': ['white', 'white'],
  'kitchen-wall': ['white', 'white'],
  island: ['white', 'worktop'],
  fridge: ['steel', 'steel'],
  toilet: ['ceramic', 'ceramic'],
  basin: ['ceramic', 'chrome'],
  vanity: ['white', 'ceramic'],
  bathtub: ['ceramic', 'chrome'],
  shower: ['ceramic', 'chrome'],
  washer: ['white', 'black-steel'],
  'office-chair': ['black-steel', 'fabric'],
  chair: ['wood', 'fabric'],
  'dining-table': ['wood', 'black-steel'],
  desk: ['wood', 'black-steel'],
  'coffee-table': ['dark-wood', 'dark-wood'],
  plant: ['leaf', 'pot'],
  'floor-lamp': ['black-steel', 'linen'],
  rug: ['carpet', 'carpet'],
  stairs: ['wood', 'white'],
};

const DEFAULT_ELEVATION: Partial<Record<FurnitureType, number>> = {
  'kitchen-wall': 1.45,
  hob: 0.9,
  sink: 0.9,
};

function shadowed<T extends THREE.Mesh>(m: T) {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = h / 2, z = 0) {
  const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
  m.position.set(x, y, z);
  return m;
}

function soft(w: number, h: number, d: number, r: number, mat: THREE.Material, x = 0, y = h / 2, z = 0) {
  const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  // 6 segments per bevel: edges catch light as smooth curves instead of faceted bands.
  const m = shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 6, Math.max(0.001, rr)), mat));
  m.position.set(x, y, z);
  return m;
}

/**
 * A filled cushion: a rounded box whose faces dome outward in the middle and pinch toward the
 * seams, with faint creases. Boxes with even bevels read as moulded plastic; this silhouette
 * is what makes upholstery read as soft. `axis` is the cushion's thin direction.
 */
function pillow(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = h / 2, z = 0, axis: 'y' | 'z' = 'y', puff = 0.35) {
  // Size the box so the domed middle ends at the requested thickness.
  const thin = axis === 'y' ? h : d;
  const core = thin / (1 + puff);
  const g = new RoundedBoxGeometry(w, axis === 'y' ? core : h, axis === 'y' ? d : core, 10, Math.min(core * 0.45, 0.06));
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const a = axis === 'y' ? (2 * v.x) / w : (2 * v.x) / w;
    const b = axis === 'y' ? (2 * v.z) / d : (2 * v.y) / h;
    const dome = 1 + puff * Math.max(0, 1 - a * a) * Math.max(0, 1 - b * b);
    // Soft creases: a few low, irregular folds, strongest near the edges where fabric gathers.
    const crease = 0.004 * Math.sin(a * 9.1 + b * 3.7) * Math.sin(b * 7.3 - a * 2.1) * (Math.abs(a) + Math.abs(b));
    if (axis === 'y') v.y = v.y * dome + Math.sign(v.y) * crease;
    else v.z = v.z * dome + Math.sign(v.z) * crease;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const m = shadowed(new THREE.Mesh(g, mat));
  m.position.set(x, y, z);
  return m;
}

function cyl(rt: number, rb: number, h: number, mat: THREE.Material, x = 0, y = h / 2, z = 0, seg = 64) {
  const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat));
  m.position.set(x, y, z);
  return m;
}

// Both are created per build: the renderer hooks a dispose listener into every material it draws,
// so module-level materials would keep each unmounted viewer's renderer alive.
let gapMat: THREE.MeshStandardMaterial;
/** Shared plain materials, so identical pieces merge into one draw call. */
let plainCache = new Map<string, THREE.MeshStandardMaterial>();
function plain(color: string, roughness: number, metalness = 0) {
  const k = `${color}/${roughness}/${metalness}`;
  let m = plainCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    plainCache.set(k, m);
  }
  return m;
}

/** Thin dark lines between cabinet fronts. */
function fronts(w: number, h: number, z: number, y0: number, width = 0.6) {
  const out: THREE.Object3D[] = [];
  const n = Math.max(1, Math.round(w / width));
  for (let i = 1; i < n; i++) out.push(box(0.004, h - 0.02, 0.002, gapMat, -w / 2 + (w / n) * i, y0 + h / 2, z));
  return out;
}

function legs4(w: number, d: number, h: number, mat: THREE.Material, inset = 0.05, r = 0.022) {
  const out: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box(r * 2, h, r * 2, mat, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset)));
  return out;
}

const B: Record<FurnitureType, Builder> = {
  bed({ w, d, h }, m, a) {
    const base = 0.32, mattress = 0.22;
    const out: THREE.Object3D[] = [
      soft(w, base, d - 0.06, 0.02, a, 0, base / 2 + 0.04, 0.03),
      pillow(w - 0.06, mattress, d - 0.14, m, 0, base + 0.04 + mattress / 2, 0.04, 'y', 0.12),
      // Duvet covers the foot two thirds and hangs a little over the sides.
      soft(w - 0.02, 0.06, (d - 0.14) * 0.68, 0.03, m, 0, base + 0.04 + mattress + 0.01, 0.04 + (d - 0.14) * 0.16),
      soft(w, Math.max(h, 0.9), 0.08, 0.02, a, 0, Math.max(h, 0.9) / 2, -d / 2 + 0.04),
      ...legs4(w, d - 0.06, 0.06, a, 0.06),
    ];
    const pillows = w < 1.2 ? 1 : 2;
    const pw = (w - 0.2) / pillows;
    for (let i = 0; i < pillows; i++)
      out.push(pillow(pw - 0.06, 0.15, 0.42, m, -w / 2 + 0.1 + pw * (i + 0.5), base + 0.04 + mattress + 0.07, -d / 2 + 0.34, 'y', 0.9));
    return out;
  },
  nightstand({ w, d, h }, m) {
    return [soft(w, h - 0.08, d, 0.01, m, 0, (h - 0.08) / 2 + 0.08), ...legs4(w, d, 0.08, m, 0.04, 0.012), box(w - 0.04, 0.003, 0.002, gapMat, 0, h * 0.6, d / 2 + 0.001)];
  },
  wardrobe({ w, d, h }, m, _a, mat) {
    const out: THREE.Object3D[] = [box(w, h - 0.06, d, m, 0, (h - 0.06) / 2 + 0.06), box(w - 0.04, 0.06, d - 0.06, gapMat, 0, 0.03, -0.02)];
    out.push(...fronts(w, h - 0.06, d / 2 + 0.001, 0.06, 0.5));
    const n = Math.max(1, Math.round(w / 0.5));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (w / n) * (i + (i % 2 ? 0.1 : 0.9));
      out.push(box(0.012, 0.3, 0.025, mat('black-steel'), x, 1.05, d / 2 + 0.015));
    }
    return out;
  },
  dresser({ w, d, h }, m, _a, mat) {
    const out: THREE.Object3D[] = [box(w, h - 0.1, d, m, 0, (h - 0.1) / 2 + 0.1), ...legs4(w, d, 0.1, mat('dark-wood'), 0.05, 0.015)];
    for (let i = 1; i < 3; i++) out.push(box(w - 0.04, 0.004, 0.002, gapMat, 0, 0.1 + ((h - 0.1) / 3) * i, d / 2 + 0.001));
    return out;
  },
  sofa({ w, d, h }, m, a, mat) {
    const arm = 0.18, seatH = 0.44, backD = 0.22;
    const out: THREE.Object3D[] = [
      soft(w, 0.24, d, 0.03, m, 0, 0.12 + 0.08),
      soft(w - arm * 2, h - 0.08, backD, 0.06, m, 0, (h - 0.08) / 2 + 0.08, -d / 2 + backD / 2),
      soft(arm, 0.62 - 0.08, d, 0.06, m, -w / 2 + arm / 2, (0.62 - 0.08) / 2 + 0.08),
      soft(arm, 0.62 - 0.08, d, 0.06, m, w / 2 - arm / 2, (0.62 - 0.08) / 2 + 0.08),
      ...legs4(w, d, 0.08, a, 0.06, 0.018),
    ];
    const seats = w > 1.9 ? 3 : 2;
    const sw = (w - arm * 2) / seats;
    for (let i = 0; i < seats; i++) {
      const x = -w / 2 + arm + sw * (i + 0.5);
      out.push(pillow(sw - 0.01, 0.16, d - backD - 0.03, m, x, seatH - 0.07 + 0.02, backD / 2 + 0.01, 'y', 0.35));
      // Back cushions lean back a few degrees, like they do once someone has sat on them.
      const back = pillow(sw - 0.04, 0.44, 0.2, m, x, seatH + 0.2, -d / 2 + backD + 0.05, 'z', 0.55);
      back.rotation.x = -0.12;
      out.push(back);
    }
    // Throw pillows leaning into the corners: two colours, slightly turned, as people leave them.
    const usable = (w - arm * 2) / 2 - 0.28;
    [[-1, 'cushion-velvet', 0.25], [1, 'cushion-linen', -0.2], [0.72, 'cushion-velvet', -0.05]].forEach(([side, key, yaw], i) => {
      if (i === 2 && w < 2.1) return;
      const p = pillow(0.46, 0.46, 0.16, mat(key as string), (side as number) * usable, seatH + 0.27, -d / 2 + backD + 0.2, 'z', 0.7);
      p.rotation.set(-0.32, yaw as number, (side as number) * -0.12);
      out.push(p);
    });
    return out;
  },
  armchair({ w, d, h }, m, a) {
    const arm = 0.14;
    return [
      soft(w, 0.24, d, 0.03, m, 0, 0.2),
      soft(w - arm * 2, h - 0.12, 0.18, 0.06, m, 0, (h - 0.12) / 2 + 0.12, -d / 2 + 0.09),
      soft(arm, 0.5, d, 0.05, m, -w / 2 + arm / 2, 0.37),
      soft(arm, 0.5, d, 0.05, m, w / 2 - arm / 2, 0.37),
      pillow(w - arm * 2 - 0.02, 0.15, d - 0.22, m, 0, 0.385, 0.08, 'y', 0.35),
      ...legs4(w, d, 0.1, a, 0.06, 0.016),
    ];
  },
  'coffee-table'({ w, d, h }, m) {
    return [soft(w, 0.035, d, 0.012, m, 0, h - 0.0175), soft(w - 0.1, 0.02, d - 0.1, 0.008, m, 0, 0.12), ...legs4(w, d, h - 0.035, m, 0.05, 0.02)];
  },
  'tv-unit'({ w, d, h }, m, _a, mat) {
    const tvW = Math.min(1.45, w * 0.8), tvH = tvW * 0.5625;
    return [
      box(w, h - 0.06, d, m, 0, (h - 0.06) / 2 + 0.06),
      box(w - 0.06, 0.06, d - 0.06, gapMat, 0, 0.03, 0),
      ...fronts(w, h - 0.06, d / 2 + 0.001, 0.06, w / 3),
      box(tvW, tvH, 0.03, mat('screen'), 0, h + 0.08 + tvH / 2, -d / 2 + 0.1),
      box(0.25, 0.012, 0.18, mat('black-steel'), 0, h + 0.006, -d / 2 + 0.12),
      box(0.04, 0.08, 0.04, mat('black-steel'), 0, h + 0.04, -d / 2 + 0.1),
    ];
  },
  tv({ w, h }, _m, _a, mat) {
    // Wall-mounted look on a slim foot, sized by screen width; h is the top edge.
    const screenH = w * 0.5625;
    const y0 = Math.max(0.06, h - screenH);
    return [
      box(w, screenH, 0.03, mat('screen'), 0, y0 + screenH / 2, 0),
      box(w + 0.01, screenH + 0.01, 0.02, mat('black-steel'), 0, y0 + screenH / 2, -0.015),
      box(0.3, 0.012, 0.2, mat('black-steel'), 0, 0.006, 0),
      box(0.05, y0, 0.03, mat('black-steel'), 0, y0 / 2, -0.02),
    ];
  },
  rug({ w, d }, m) {
    const r = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, 0.008, d), m));
    r.position.y = 0.004;
    r.castShadow = false;
    return [r];
  },
  bookshelf({ w, d, h }, m) {
    const t = 0.025;
    const out: THREE.Object3D[] = [
      box(t, h, d, m, -w / 2 + t / 2), box(t, h, d, m, w / 2 - t / 2),
      box(w, t, d, m, 0, h - t / 2), box(w, 0.08, d, m, 0, 0.04), box(w - 2 * t, h, 0.01, m, 0, h / 2, -d / 2 + 0.005),
    ];
    const shelves = Math.max(2, Math.round(h / 0.38));
    const palette = ['#7d4b3a', '#d8cbb3', '#3f5468', '#a68b5b', '#2e2e2e', '#9a5a46', '#e4ddd0', '#5c6b52'];
    let seed = Math.round(w * 1000 + h * 7);
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 1; i < shelves; i++) {
      const y = 0.08 + ((h - 0.08) / shelves) * i;
      out.push(box(w - 2 * t, t, d - 0.01, m, 0, y));
      let x = -w / 2 + t + 0.02;
      while (x < w / 2 - t - 0.12 && rnd() > 0.06) {
        const bw = 0.02 + rnd() * 0.035, bh = 0.18 + rnd() * 0.1;
        const bm = plain(palette[Math.floor(rnd() * palette.length)], 0.8);
        out.push(box(bw, bh, d * 0.75, bm, x + bw / 2, y + t / 2 + bh / 2, 0.01));
        x += bw + 0.002;
        if (rnd() > 0.85) x += 0.08;
      }
    }
    return out;
  },
  'floor-lamp'({ h }, m, a, mat) {
    const shade = cyl(0.17, 0.2, 0.28, a, 0, h - 0.14);
    shade.castShadow = false;
    const glow = cyl(0.03, 0.03, 0.05, mat('bulb'), 0, h - 0.2);
    return [cyl(0.15, 0.15, 0.02, m, 0, 0.01), cyl(0.012, 0.012, h - 0.2, m, 0, (h - 0.2) / 2 + 0.02), shade, glow];
  },
  plant({ w, h }, m, a, mat) {
    const potH = Math.min(0.45, h * 0.35);
    const out: THREE.Object3D[] = [cyl(w * 0.36, w * 0.3, potH, a, 0, potH / 2)];
    const leafGeo = new THREE.IcosahedronGeometry(1, 3);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 9; i++) {
      const s = w * (0.22 + rnd() * 0.16);
      const leaf = shadowed(new THREE.Mesh(leafGeo, m));
      leaf.scale.set(s, s * 1.3, s);
      const ang = rnd() * Math.PI * 2, rad = rnd() * w * 0.28;
      leaf.position.set(Math.cos(ang) * rad, potH + (h - potH) * (0.25 + rnd() * 0.55), Math.sin(ang) * rad);
      out.push(leaf);
    }
    out.push(cyl(0.012, 0.012, (h - potH) * 0.6, mat('dark-wood'), 0, potH + (h - potH) * 0.3));
    return out;
  },
  'dining-table'({ w, d, h }, m, a) {
    return [soft(w, 0.04, d, 0.01, m, 0, h - 0.02), ...legs4(w, d, h - 0.04, a, 0.08, 0.025)];
  },
  chair({ w, d, h }, m, a) {
    const seat = 0.46;
    return [
      soft(w, 0.05, d - 0.04, 0.02, a, 0, seat - 0.025, 0.02),
      soft(w, h - seat, 0.03, 0.012, m, 0, seat + (h - seat) / 2, -d / 2 + 0.03),
      ...legs4(w, d, seat - 0.05, m, 0.03, 0.016),
    ];
  },
  desk({ w, d, h }, m, a) {
    return [soft(w, 0.03, d, 0.006, m, 0, h - 0.015), box(0.03, h - 0.03, d - 0.08, a, -w / 2 + 0.06, (h - 0.03) / 2), box(0.03, h - 0.03, d - 0.08, a, w / 2 - 0.06, (h - 0.03) / 2), box(w - 0.15, 0.03, 0.02, a, 0, 0.12, -d / 2 + 0.08)];
  },
  'office-chair'({ w, d, h }, m, a) {
    const out: THREE.Object3D[] = [cyl(0.03, 0.03, 0.36, m, 0, 0.25)];
    for (let i = 0; i < 5; i++) {
      const arm = box(0.04, 0.03, w / 2, m, 0, 0.06, 0);
      arm.geometry.translate(0, 0, w / 4);
      arm.rotation.y = (i / 5) * Math.PI * 2;
      out.push(arm);
    }
    out.push(soft(w * 0.85, 0.08, d * 0.8, 0.03, a, 0, 0.47, 0.02));
    out.push(soft(w * 0.8, h - 0.6, 0.06, 0.03, a, 0, 0.6 + (h - 0.6) / 2, -d / 2 + 0.07));
    return out;
  },
  'kitchen-base'({ w, d, h }, m, a, mat) {
    const plinth = 0.1, top = 0.035;
    return [
      box(w, h - plinth - top, d - 0.02, m, 0, plinth + (h - plinth - top) / 2, -0.01),
      box(w, plinth, d - 0.08, gapMat, 0, plinth / 2, -0.04),
      box(w + 0.01, top, d + 0.02, a, 0, h - top / 2, 0.01),
      ...fronts(w, h - plinth - top, d / 2 - 0.009, plinth),
      box(w - 0.04, 0.004, 0.002, gapMat, 0, h - top - 0.16, d / 2 - 0.009),
      ...Array.from({ length: Math.max(1, Math.round(w / 0.6)) }, (_, i) =>
        box(0.16, 0.012, 0.02, mat('black-steel'), -w / 2 + (w / Math.max(1, Math.round(w / 0.6))) * (i + 0.5), h - top - 0.08, d / 2 + 0.005)),
    ];
  },
  'kitchen-tall'({ w, d, h }, m, _a, mat) {
    return [
      box(w, h - 0.1, d - 0.02, m, 0, 0.1 + (h - 0.1) / 2, -0.01),
      box(w, 0.1, d - 0.08, gapMat, 0, 0.05, -0.04),
      ...fronts(w, h - 0.1, d / 2 - 0.009, 0.1),
      box(w - 0.04, 0.004, 0.002, gapMat, 0, 0.1 + (h - 0.1) * 0.62, d / 2 - 0.009),
      box(0.012, 0.3, 0.02, mat('black-steel'), w / 2 - 0.05, 1.1, d / 2 + 0.005),
    ];
  },
  'kitchen-wall'({ w, d, h }, m) {
    return [box(w, h, d, m), ...fronts(w, h, d / 2 + 0.001, 0, 0.6)];
  },
  island({ w, d, h }, m, a) {
    const top = 0.04;
    return [
      box(w - 0.1, h - 0.1 - top, d - 0.3, m, 0, 0.1 + (h - 0.1 - top) / 2, -0.15),
      box(w - 0.16, 0.1, d - 0.36, gapMat, 0, 0.05, -0.15),
      box(w, top, d, a, 0, h - top / 2, 0),
      ...fronts(w - 0.1, h - 0.1 - top, -d / 2 - 0.001, 0.1),
    ];
  },
  fridge({ w, d, h }, m, _a, mat) {
    return [soft(w, h, d, 0.015, m), box(w - 0.02, 0.004, 0.002, gapMat, 0, h * 0.62, d / 2 + 0.001), box(0.015, 0.4, 0.03, mat('chrome'), w / 2 - 0.06, h * 0.78, d / 2 + 0.02), box(0.015, 0.4, 0.03, mat('chrome'), w / 2 - 0.06, h * 0.45, d / 2 + 0.02)];
  },
  hob({ w, d }, _m, _a, mat) {
    const out: THREE.Object3D[] = [box(w, 0.008, d, mat('screen'), 0, 0.004)];
    const ring = plain('#4a4a4a', 0.4);
    for (const [x, z, r] of [[-0.15, -0.1, 0.1], [0.15, -0.1, 0.08], [-0.15, 0.12, 0.08], [0.15, 0.12, 0.1]] as const) {
      const c = new THREE.Mesh(new THREE.RingGeometry(r - 0.006, r, 40), ring);
      c.rotation.x = -Math.PI / 2;
      c.position.set(x, 0.0085, z);
      out.push(c);
    }
    return out;
  },
  sink({ w, d }, _m, a) {
    // Undermount bowl suggested by a dark inset, plus a tall arched tap.
    const bowl = plain('#8b8d8e', 0.3, 0.9);
    const tap = a;
    const spout = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.012, 10, 24, Math.PI), tap));
    spout.rotation.y = Math.PI / 2;
    spout.position.set(0, 0.28, -d / 2 + 0.06 + 0.11);
    return [
      box(w - 0.1, 0.004, d - 0.12, bowl, 0, 0.002, 0.02),
      cyl(0.016, 0.02, 0.28, tap, 0, 0.14, -d / 2 + 0.06),
      spout,
    ];
  },
  toilet({ w, d, h }, m) {
    const bowl = cyl(w / 2, w / 2.6, 0.4, m, 0, 0.2, 0.06);
    bowl.scale.z = (d - 0.16) / w;
    const seat = soft(w, 0.03, d - 0.14, 0.015, m, 0, 0.415, 0.06);
    return [bowl, seat, soft(w * 0.95, h - 0.38, 0.16, 0.03, m, 0, 0.38 + (h - 0.38) / 2, -d / 2 + 0.08)];
  },
  basin({ w, d, h }, m, a) {
    return [soft(w, 0.14, d, 0.03, m, 0, h - 0.07), cyl(0.014, 0.016, 0.2, a, 0, h + 0.1, -d / 2 + 0.06)];
  },
  vanity({ w, d, h }, m, a, mat) {
    return [
      box(w, h - 0.35, d, m, 0, 0.3 + (h - 0.35) / 2),
      soft(w, 0.05, d + 0.01, 0.01, a, 0, h - 0.025),
      box(w - 0.04, 0.004, 0.002, gapMat, 0, 0.3 + (h - 0.35) / 2, d / 2 + 0.001),
      cyl(0.014, 0.016, 0.2, mat('chrome'), 0, h + 0.1, -d / 2 + 0.06),
      // Mirror on the wall behind.
      box(w * 0.85, 0.7, 0.012, plain('#dfe4e6', 0.03, 1), 0, h + 0.65, -d / 2 + 0.006),
    ];
  },
  bathtub({ w, d, h }, m, a) {
    const r = 0.07;
    return [
      box(w, h - 0.04, d, m, 0, (h - 0.04) / 2),
      box(w, 0.04, r, m, 0, h - 0.02, -d / 2 + r / 2),
      box(w, 0.04, r, m, 0, h - 0.02, d / 2 - r / 2),
      box(r, 0.04, d - 2 * r, m, -w / 2 + r / 2, h - 0.02),
      box(r, 0.04, d - 2 * r, m, w / 2 - r / 2, h - 0.02),
      box(w - 2 * r, 0.02, d - 2 * r, plain('#e9ecec', 0.08), 0, h - 0.05),
      cyl(0.014, 0.014, 0.12, a, -w / 2 + 0.2, h + 0.06, -d / 2 + 0.035),
    ];
  },
  shower({ w, d, h }, m, a, mat) {
    const glass = mat('glass');
    const front = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.55, h - 0.05), glass);
    front.position.set(w / 2 - (w * 0.55) / 2, 0.05 + (h - 0.05) / 2, d / 2);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(d, h - 0.05), glass);
    side.rotation.y = Math.PI / 2;
    side.position.set(-w / 2, 0.05 + (h - 0.05) / 2, 0);
    front.userData.kind = side.userData.kind = 'glass';
    return [
      box(w, 0.05, d, m),
      front, side,
      box(0.02, h - 0.05, 0.02, a, -w / 2, 0.05 + (h - 0.05) / 2, d / 2),
      cyl(0.012, 0.012, 1.2, a, w / 2 - 0.15, 1.3, -d / 2 + 0.04),
      cyl(0.11, 0.11, 0.015, a, w / 2 - 0.15, 2.0, -d / 2 + 0.16),
      box(0.02, 0.02, 0.15, a, w / 2 - 0.15, 1.99, -d / 2 + 0.1),
    ];
  },
  washer({ w, d, h }, m, a) {
    const door = cyl(0.2, 0.2, 0.02, a, 0, h * 0.45, d / 2 + 0.01, 40);
    door.rotation.x = Math.PI / 2;
    return [soft(w, h, d, 0.015, m), door, box(w - 0.06, 0.004, 0.002, gapMat, 0, h - 0.13, d / 2 + 0.001)];
  },
  stairs({ w, d, h }, m, a) {
    const out: THREE.Object3D[] = [];
    const n = Math.max(3, Math.round(h / 0.18));
    const rise = h / n, run = d / n;
    for (let i = 0; i < n; i++) {
      // Front faces +z at the bottom step; the flight climbs toward −z.
      out.push(box(w, 0.04, run + 0.03, m, 0, rise * (i + 1) - 0.02, d / 2 - run * (i + 0.5)));
      out.push(box(w, rise - 0.04, 0.02, a, 0, rise * i + (rise - 0.04) / 2, d / 2 - run * i - 0.01));
    }
    return out;
  },
  box({ w, d, h }, m) {
    return [box(w, h, d, m)];
  },
};

/**
 * Gives a procedural piece UVs in meters, projected along each face's main axis,
 * so wood grain and fabric weave keep their real scale on every box and cushion.
 */
function projectUVs(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // A geometry shared by several meshes (plant leaves) gets its own copy per mesh.
    if (mesh.geometry.userData.projected) mesh.geometry = mesh.geometry.clone();
    const g = mesh.geometry;
    if (!g.attributes.uv || !g.attributes.normal) return;
    m.multiplyMatrices(inv, mesh.matrixWorld);
    nm.getNormalMatrix(m);
    const pos = g.attributes.position, nor = g.attributes.normal;
    const uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      n.fromBufferAttribute(nor, i).applyMatrix3(nm);
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      if (ax >= ay && ax >= az) uv.setXY(i, p.z, p.y);
      else if (ay >= az) uv.setXY(i, p.x, p.z);
      else uv.setXY(i, p.x, p.y);
    }
    g.setAttribute('uv', uv);
    g.userData.projected = true;
  });
}

/**
 * Library models ship quantized (16-bit positions, 8-bit normals) for a smaller download; the
 * house merges static meshes into plain float buffers, so expand them once on load.
 */
function dequantize(root: THREE.Object3D) {
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (!g) return;
    for (const [name, a] of Object.entries(g.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][]) {
      if (a.array instanceof Float32Array && !a.normalized && !(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
      g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
    }
  });
}

export interface ModelInfo {
  url?: string;
  /** Turn (degrees, clockwise in plan) that makes the model's front face +z. */
  front: number;
}

async function loadModel(gltf: GLTFLoader, cache: Map<string, Promise<THREE.Group>>, info: ModelInfo, size?: [number, number, number]) {
  // Four dining chairs are one download and one set of GPU buffers and textures: clones share both.
  let scene = cache.get(info.url!);
  if (!scene) {
    scene = gltf.loadAsync(info.url!).then((r) => {
      dequantize(r.scene);
      return r.scene;
    });
    cache.set(info.url!, scene);
  }
  const obj = (await scene).clone();
  const turn = new THREE.Group();
  turn.add(obj);
  turn.rotation.y = -THREE.MathUtils.degToRad(info.front);
  turn.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(turn);
  const s = bb.getSize(new THREE.Vector3());
  // Library models are modelled at real size; only scale when the plan asks for a size,
  // and then uniformly so a chair never gets stretched into a bench.
  const k = size ? Math.min(size[0] / (s.x || 1), size[2] / (s.y || 1), size[1] / (s.z || 1)) : 1;
  turn.scale.setScalar(k);
  turn.updateMatrixWorld(true);
  const bb2 = new THREE.Box3().setFromObject(turn);
  const c = bb2.getCenter(new THREE.Vector3());
  turn.position.set(-c.x, -bb2.min.y, -c.z);
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // Alpha-tested foliage casts its silhouette; clear glass must not cast an
    // opaque panel, since the standard shadow pass does not transmit light.
    mesh.castShadow = materials.some(material => !(material.transparent && material.opacity < 1 && material.alphaTest === 0) && !('transmission' in material && Number(material.transmission) > 0));
    mesh.receiveShadow = true;
  });
  const g = new THREE.Group();
  g.add(turn);
  return g;
}

/** The main and accent finishes a piece is drawn with: its own, or its type's. */
export function pieceFinishes(f: Pick<Furniture, 'type' | 'material' | 'accent'>): [string, string] {
  const [mk, ak] = DEFAULT_MAT[f.type] ?? ['wood', 'dark-wood'];
  return [f.material ?? mk, f.accent ?? ak];
}

const FIXTURES = new Set<string>([
  'kitchen-base', 'kitchen-tall', 'kitchen-wall', 'island', 'fridge', 'hob', 'sink', 'toilet', 'basin',
  'vanity', 'bathtub', 'shower', 'washer', 'stairs', 'wardrobe',
]);
/** Built-in pieces a buyer gets with the flat stay when "hide furniture" empties the rooms. */
export function isFixture(furniture: Pick<Furniture, 'type' | 'fixture'>) {
  return furniture.fixture ?? FIXTURES.has(furniture.type);
}

export async function buildFurniture(
  plan: Plan,
  lib: MaterialLibrary,
  mat: MatFn,
  resolveUrl: (p: string) => string | undefined,
  modelInfo: (path: string) => ModelInfo = (p) => ({ url: resolveUrl(p), front: 0 }),
  manager?: THREE.LoadingManager,
) {
  void lib;
  plainCache = new Map();
  gapMat = new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.9 });
  const gltf = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const models = new Map<string, Promise<THREE.Group>>();
  const group = new THREE.Group();
  group.name = 'furniture';
  await Promise.all(
    (plan.furniture ?? []).map(async (f: Furniture) => {
      const size = f.size ?? FURNITURE_DEFAULT_SIZE[f.type] ?? [0.5, 0.5, 0.5];
      const [mk, ak] = pieceFinishes(f);
      const m = mat(mk);
      const a = mat(ak);
      let obj: THREE.Object3D | null = null;
      const info = f.model ? modelInfo(f.model) : undefined;
      if (info?.url) {
        try {
          obj = await loadModel(gltf, models, info, f.size);
        } catch (e) {
          console.warn(`furniture ${f.id}: model failed to load, using the built-in shape`, e);
        }
      } else if (f.model) console.warn(`furniture ${f.id}: model ${f.model} not found, using the built-in shape`);
      if (!obj) {
        obj = new THREE.Group().add(...(B[f.type] ?? B.box)({ w: size[0], d: size[1], h: size[2] }, m, a, mat));
        projectUVs(obj);
      }
      obj.position.set(f.position[0], f.elevation ?? DEFAULT_ELEVATION[f.type] ?? 0, f.position[1]);
      // Plan rotation is clockwise on screen with y down; in three.js that is a negative turn about +y.
      obj.rotation.y = -THREE.MathUtils.degToRad(f.rotation ?? 0);
      obj.name = f.id;
      // Walk-through: rugs, worktop fittings, slim lamps, and anything hung or standing on
      // other furniture. Their bounding boxes are mostly air and would block doorways.
      // A roof's bounding box would wall in the whole storey; the walker meets the ceilings instead.
      // Ground collides as its own surface (see buildHouse), never as a box.
      const passable = f.roof || f.ground || ['rug', 'hob', 'sink', 'floor-lamp', 'plant'].includes(f.type) || (f.elevation ?? DEFAULT_ELEVATION[f.type] ?? 0) > 0.3;
      obj.userData = {
        kind: 'furniture', id: f.id, type: f.type, size, collide: !passable, loose: !f.roof && !f.ground && !isFixture(f), roof: !!f.roof,
        ...(f.ground && { ground: true }), ...(f.designOptions && { designOptions: f.designOptions }),
      };
      group.add(obj);
    }),
  );
  return group;
}
