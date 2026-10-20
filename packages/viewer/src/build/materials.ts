import * as THREE from 'three/webgpu';
import { abs, dot, float, normalView, positionViewDirection } from 'three/tsl';
import type { MaterialDef, Plan } from '../plan/schema.ts';
import { withDefaults } from '../plan/schema.ts';

/**
 * Built-in finishes used when a plan references a key it does not define.
 * Plans can override any of these in `plan.materials`.
 */
export const BUILTIN: Record<string, MaterialDef> = {
  'paint-white': { color: '#f2efe9', roughness: 0.92 },
  'render-white': { color: '#ece8e0', pattern: 'plaster', roughness: 0.95 },
  oak: { color: '#c49a6c', pattern: 'planks', module: [1.4, 0.19], seam: '#8a6440', roughness: 0.55 },
  'tile-grey': { color: '#bdb8b0', pattern: 'large-tiles', module: [0.6, 0.6], seam: '#9d978e', roughness: 0.4 },
  concrete: { color: '#b3afa8', pattern: 'concrete', roughness: 0.85 },
  carpet: { color: '#b9b1a4', pattern: 'carpet', roughness: 1 },
  fabric: { color: '#9a9a92', pattern: 'fabric', roughness: 0.95 },
  wood: { color: '#a7825c', roughness: 0.55 },
  'dark-wood': { color: '#5e3d27', roughness: 0.5 },
  white: { color: '#f3f1ec', roughness: 0.5 },
  ceramic: { color: '#f6f5f2', roughness: 0.12, clearcoat: 0.8, clearcoatRoughness: 0.04 },
  steel: { color: '#c9cbcc', roughness: 0.25, metalness: 1 },
  'black-steel': { color: '#1d1d1d', roughness: 0.4, metalness: 0.6 },
  chrome: { color: '#dadada', roughness: 0.15, metalness: 1 },
  glass: { color: '#e4eef0', roughness: 0.02, opacity: 0.07 },
  'frame-white': { color: '#f0eee9', roughness: 0.45 },
  'frame-anthracite': { color: '#383a3c', roughness: 0.45, metalness: 0.2 },
  'door-white': { color: '#f1efea', roughness: 0.5 },
  leaf: { color: '#4f6b3c', roughness: 0.8 },
  pot: { color: '#d8d2c8', roughness: 0.75 },
  screen: { color: '#0c0c0d', roughness: 0.15, metalness: 0.2 },
  ground: { color: '#a4a594', pattern: 'concrete', roughness: 1 },
  slab: { color: '#d8d4cc', roughness: 0.9 },
  skirting: { color: '#f4f2ee', roughness: 0.5 },
  'cushion-velvet': { color: '#9c5a3c', roughness: 1, sheen: 1, sheenRoughness: 0.35, sheenColor: '#e0a07a', specularIntensity: 0.1 },
  'cushion-linen': { color: '#d8d0c2', roughness: 1, sheen: 0.7, sheenRoughness: 0.6, specularIntensity: 0.12 },
  worktop: { color: '#2f2d2a', roughness: 0.28 },
  linen: { color: '#e8e2d7', pattern: 'fabric', roughness: 0.95 },
  bulb: { color: '#fff6e4', roughness: 1, emissive: '#fff1d6' },
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Opacity clear glass adds at grazing view, on top of its own. */
const GLASS_GRAZING = 0.6;
/** Default clearcoat roughness on floors; explicit authored values take precedence. */
const FLOOR_COAT_ROUGHNESS = 0.35;

/** Fetches and decodes an image off the main thread, flipped the way three expects image textures. */
async function decodeBitmap(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return createImageBitmap(await res.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** Drops the decoded pixels from memory once the GPU has its copy. */
function closeAfterUpload(tex: THREE.Texture) {
  (tex.image as ImageBitmap).close?.();
}

/** Small deterministic PRNG so procedural textures look the same on every load. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function shade(hex: string, amount: number) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)));
  return `#${c.getHexString()}`;
}

/**
 * Draws a tileable pattern on a canvas. The canvas covers `size` meters, so
 * texture.repeat = 1 / size gives correct real-world scale on geometry whose
 * UVs are in meters (floors and walls here use meter UVs).
 */
function drawPattern(def: MaterialDef, key: string): { canvas: HTMLCanvasElement; size: [number, number] } {
  const px = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const g = canvas.getContext('2d')!;
  const rand = rng(hashString(key));
  const base = def.color;
  const seam = def.seam ?? shade(base, -0.18);
  const [mw, mh] = def.module ?? [1.2, 0.2];
  g.fillStyle = base;
  g.fillRect(0, 0, px, px);

  const grain = (x: number, y: number, w: number, h: number, tone: string) => {
    // Long, low-contrast streaks along the plank give a wood read without a photo.
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = tone;
    g.fillRect(x, y, w, h);
    for (let i = 0; i < 26; i++) {
      const yy = y + rand() * h;
      g.strokeStyle = shade(tone, (rand() - 0.5) * 0.09);
      g.globalAlpha = 0.35;
      g.lineWidth = 0.6 + rand() * 1.8;
      g.beginPath();
      g.moveTo(x, yy);
      const segs = 6;
      for (let s = 1; s <= segs; s++) g.lineTo(x + (w * s) / segs, yy + (rand() - 0.5) * h * 0.18);
      g.stroke();
    }
    g.restore();
    g.globalAlpha = 1;
  };

  switch (def.pattern) {
    case 'planks': {
      // Canvas covers exactly 2 plank lengths by N rows so it tiles.
      const rows = Math.max(1, Math.round(1.2 / mh));
      const size: [number, number] = [mw * 2, mh * rows];
      const sx = px / size[0], sy = px / size[1];
      for (let r = 0; r < rows; r++) {
        const shift = ((r * 0.37) % 1) * mw;
        for (let k = -1; k < 3; k++) {
          const x0 = (k * mw + shift) * sx;
          const tone = shade(base, (rand() - 0.5) * 0.12);
          grain(x0, r * mh * sy, mw * sx, mh * sy, tone);
          g.fillStyle = seam;
          g.fillRect(x0, r * mh * sy, 2, mh * sy);
        }
        g.fillStyle = seam;
        g.fillRect(0, r * mh * sy, px, 2);
      }
      return { canvas, size };
    }
    case 'herringbone': {
      // Drawn per pixel as a chevron: columns of planks at ±45°, alternating.
      // The canvas spans two columns and a whole number of plank rows so it tiles.
      const colW = mw * Math.SQRT1_2;
      const rowH = mh * Math.SQRT2;
      const rows = Math.max(1, Math.round((colW * 2) / rowH));
      const size: [number, number] = [colW * 2, rowH * rows];
      const img = g.createImageData(px, px);
      const baseC = new THREE.Color(base), seamC = new THREE.Color(seam);
      const tones = Array.from({ length: 2 * rows }, () => 1 + (rand() - 0.5) * 0.14);
      for (let j = 0; j < px; j++) {
        const v = (j / px) * size[1];
        for (let i = 0; i < px; i++) {
          const u = (i / px) * size[0];
          const c = u < colW ? 0 : 1;
          const ul = u - c * colW;
          const sgn = c === 0 ? 1 : -1;
          // Shift along v by the column's x so planks slant at 45°.
          const t = (v + sgn * ul - (c === 0 ? 0 : colW)) / rowH;
          const idx = Math.floor(t);
          const f = t - idx;
          const k = (((idx % rows) + rows) % rows) * 2 + c;
          const grainN = 0.03 * Math.sin((f * 37 + k * 3.1) * 1.7) + 0.02 * Math.sin(ul * 90 + k);
          const edge = f < 0.025 || ul < 0.0025 || colW - ul < 0.0025;
          const col = edge ? seamC : baseC;
          const m = edge ? 1 : tones[k] + grainN;
          const o = (j * px + i) * 4;
          img.data[o] = Math.min(255, col.r * 255 * m);
          img.data[o + 1] = Math.min(255, col.g * 255 * m);
          img.data[o + 2] = Math.min(255, col.b * 255 * m);
          img.data[o + 3] = 255;
        }
      }
      // ImageData takes linear bytes as-is; the Color values above are linear, so convert back to sRGB.
      for (let o = 0; o < img.data.length; o += 4)
        for (let ch = 0; ch < 3; ch++) img.data[o + ch] = 255 * (img.data[o + ch] / 255) ** (1 / 2.2);
      g.putImageData(img, 0, 0);
      return { canvas, size };
    }
    case 'tiles':
    case 'large-tiles': {
      const [tw, th] = def.module ?? (def.pattern === 'tiles' ? [0.2, 0.2] : [0.6, 0.6]);
      const nx = Math.max(1, Math.round(1.2 / tw)), ny = Math.max(1, Math.round(1.2 / th));
      const size: [number, number] = [tw * nx, th * ny];
      const cw = px / nx, ch = px / ny;
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++) {
          g.fillStyle = shade(base, (rand() - 0.5) * 0.05);
          g.fillRect(i * cw, j * ch, cw, ch);
          for (let k = 0; k < 60; k++) {
            g.fillStyle = shade(base, (rand() - 0.5) * 0.08);
            g.globalAlpha = 0.25;
            g.fillRect(i * cw + rand() * cw, j * ch + rand() * ch, 3 + rand() * 6, 3 + rand() * 6);
          }
          g.globalAlpha = 1;
        }
      g.fillStyle = seam;
      const gw = Math.max(2, px * (0.003 / size[0]));
      for (let i = 0; i <= nx; i++) g.fillRect(i * cw - gw / 2, 0, gw, px);
      for (let j = 0; j <= ny; j++) g.fillRect(0, j * ch - gw / 2, px, gw);
      return { canvas, size };
    }
    case 'carpet':
    case 'fabric':
    case 'concrete':
    case 'plaster': {
      const fine = def.pattern === 'fabric' || def.pattern === 'carpet';
      const n = fine ? 26000 : 9000;
      for (let i = 0; i < n; i++) {
        g.fillStyle = shade(base, (rand() - 0.5) * (fine ? 0.1 : 0.06));
        g.globalAlpha = fine ? 0.5 : 0.18;
        const r = fine ? 1 + rand() * 2 : 2 + rand() * 14;
        g.fillRect(rand() * px, rand() * px, r, fine ? r * 0.6 : r);
      }
      if (def.pattern === 'fabric') {
        g.globalAlpha = 0.08;
        g.fillStyle = shade(base, -0.2);
        for (let y = 0; y < px; y += 4) g.fillRect(0, y, px, 1);
      }
      g.globalAlpha = 1;
      const m = def.scale ?? (fine ? 0.5 : 2);
      return { canvas, size: [m, m] };
    }
    default:
      return { canvas, size: [1, 1] };
  }
}

/** `orm`: ambient occlusion in red, roughness in green (the glTF layout three reads). */
type MapName = 'color' | 'normal' | 'orm';

/** A PBR texture set from the shared library. */
export interface PbrSet {
  /** Meters one repeat covers. */
  size: [number, number];
  /** Small maps painted first, then `full` streams in. */
  first: Partial<Record<MapName, string>>;
  full: Partial<Record<MapName, string>>;
}

export class MaterialLibrary {
  private cache = new Map<string, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>();
  private textureLoader: THREE.TextureLoader;
  private plan: Plan;
  private resolveUrl: (path: string) => string | undefined;
  private maxAniso: number;
  private pbrSet: (id: string, floor: boolean) => PbrSet | undefined;
  private floors: Set<string>;
  private upgrades: { tex: THREE.Texture; url: string }[] = [];
  /** Maps by URL and repeat: wall paints that share a texture set share its textures too. */
  private maps = new Map<string, THREE.Texture>();
  private disposed = false;

  constructor(
    plan: Plan,
    resolveUrl: (path: string) => string | undefined,
    maxAnisotropy = 8,
    pbrSet: (id: string, floor: boolean) => PbrSet | undefined = () => undefined,
    opts: { manager?: THREE.LoadingManager } = {},
  ) {
    this.plan = plan;
    this.resolveUrl = resolveUrl;
    this.maxAniso = maxAnisotropy;
    this.pbrSet = pbrSet;
    const d = withDefaults(plan);
    this.floors = new Set([d.floor, ...(plan.rooms ?? []).map((r) => r.floor ?? d.floor)]);
    this.textureLoader = new THREE.TextureLoader(opts.manager);
  }

  /**
   * Swaps the small maps painted first for the full sets, a few at a time. Images decode off the
   * main thread (createImageBitmap), and each bitmap is closed once uploaded, so the decoded
   * pixels live only on the GPU.
   */
  async upgradeTextures(concurrency = 3, onSwap?: () => void) {
    const queue = this.upgrades.splice(0);
    const next = async (): Promise<void> => {
      const job = queue.shift();
      if (!job || this.disposed) return;
      try {
        const img = await decodeBitmap(job.url);
        if (this.disposed) return img.close();
        // A new size needs a new GPU texture; dispose drops the old one and its bind groups.
        job.tex.dispose();
        job.tex.image = img;
        job.tex.flipY = false;
        job.tex.onUpdate = closeAfterUpload;
        job.tex.needsUpdate = true;
        onSwap?.();
      } catch (e) {
        console.warn(`texture ${job.url} failed to load; keeping the small copy`, e);
      }
      return next();
    };
    await Promise.all(Array.from({ length: concurrency }, next));
  }

  private loadMap(first: string, srgb: boolean, repeat: [number, number], full?: string) {
    const key = `${first}|${repeat}`;
    const hit = this.maps.get(key);
    if (hit) return hit;
    const tex = this.textureLoader.load(first);
    this.maps.set(key, tex);
    if (full && full !== first) this.upgrades.push({ tex, url: full });
    // Albedo is sRGB; normal and roughness data must stay linear.
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / repeat[0], 1 / repeat[1]);
    tex.anisotropy = this.maxAniso;
    return tex;
  }

  def(key: string): MaterialDef {
    if (HEX.test(key)) return { color: key, roughness: 0.6 };
    return this.plan.materials?.[key] ?? BUILTIN[key] ?? { color: '#ff00ff', roughness: 0.5 };
  }

  /** Returns a shared material for a key or hex color. */
  get(key: string): THREE.MeshStandardMaterial {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const d = this.def(key);
    // Cloth sheen, lacquer coats and specular control need the physical material; it costs
    // more per pixel, so only materials that use those features get it.
    const physical = d.sheen !== undefined || d.clearcoat !== undefined || d.specularIntensity !== undefined;
    const mat = physical
      ? new THREE.MeshPhysicalMaterial({ color: d.color, roughness: d.roughness ?? 0.7, metalness: d.metalness ?? 0, name: key })
      : new THREE.MeshStandardMaterial({ color: d.color, roughness: d.roughness ?? 0.7, metalness: d.metalness ?? 0, name: key });
    if (physical) {
      const p = mat as THREE.MeshPhysicalMaterial;
      if (d.sheen !== undefined) {
        p.sheen = d.sheen;
        p.sheenRoughness = d.sheenRoughness ?? 0.6;
        p.sheenColor = new THREE.Color(d.sheenColor ?? d.color);
      }
      if (d.clearcoat !== undefined) {
        p.clearcoat = d.clearcoat;
        // Lamps are points here, so a glossy coat mirrors each one as a hard, blown dot. A real downlight
        // is a few centimetres wide; use a rougher floor default while preserving authored finishes.
        p.clearcoatRoughness = d.clearcoatRoughness ?? (this.floors.has(key) ? FLOOR_COAT_ROUGHNESS : 0.15);
      }
      if (d.specularIntensity !== undefined) p.specularIntensity = d.specularIntensity;
    }
    if (d.opacity !== undefined && d.opacity < 1) {
      mat.transparent = true;
      mat.opacity = d.opacity;
      mat.depthWrite = false;
      // Clear glass reflects more the flatter it is seen (Schlick's Fresnel); as a plain fade its
      // reflection stayed at the pane's few percent of opacity and windows read as empty holes.
      if ((mat.roughness ?? 1) < 0.1) {
        const facing = abs(dot(normalView, positionViewDirection)).clamp();
        mat.opacityNode = float(d.opacity).add(float(1).sub(facing).pow(5).mul(GLASS_GRAZING));
      }
    }
    if (d.emissive) {
      mat.emissive = new THREE.Color(d.emissive);
      mat.emissiveIntensity = 1.2;
    }
    const set = d.pbr ? this.pbrSet(d.pbr, this.floors.has(key)) : undefined;
    const url = d.texture ? this.resolveUrl(d.texture) : undefined;
    if (d.pbr && !set) console.warn(`material ${key}: library texture "${d.pbr}" not found; run bun run fetch-assets`);
    if (set) {
      const rep: [number, number] = d.scale ? [d.scale, d.scale] : set.size;
      const { first, full } = set;
      if (d.pbrColor !== false && first.color) mat.map = this.loadMap(first.color, true, rep, full.color);
      if (first.normal) {
        mat.normalMap = this.loadMap(first.normal, false, rep, full.normal);
        const n = d.normalScale ?? 1;
        mat.normalScale.set(n, n);
      }
      if (first.orm) {
        const orm = this.loadMap(first.orm, false, rep, full.orm);
        // Scanned cavity occlusion: grout lines, plank seams and weave gaps darken under
        // ambient light the way they do in photos. Same UVs as the colour map.
        mat.aoMap = orm;
        mat.aoMap.channel = 0;
        // Half strength: at full strength the scans read as dirt under the soft, even fill light.
        mat.aoMapIntensity = 0.5;
        mat.roughnessMap = orm;
        // The map carries the variation; `roughness` scales it (1 = as scanned).
        mat.roughness = d.roughness ?? 1;
      }
    } else if (url) {
      const tex = this.textureLoader.load(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const s = d.scale ?? 1;
      tex.repeat.set(1 / s, 1 / s);
      tex.anisotropy = this.maxAniso;
      mat.map = tex;
      mat.color.set('#ffffff');
    } else if (d.pattern) {
      const { canvas, size } = drawPattern(d, key);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1 / size[0], 1 / size[1]);
      tex.anisotropy = this.maxAniso;
      mat.map = tex;
      // The canvas already carries the base color; keep the tint neutral.
      mat.color.set('#ffffff');
    }
    this.cache.set(key, mat);
    return mat;
  }

  dispose() {
    this.disposed = true;
    this.upgrades.length = 0;
    for (const m of this.cache.values()) {
      for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap]) t?.dispose();
      m.dispose();
    }
    this.cache.clear();
    this.maps.clear();
  }
}
