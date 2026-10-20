import type { PbrSet } from '../build/materials.ts';
import type { ModelInfo } from '../build/furniture.ts';
import { takePrefetched } from '../preload.ts';

/** index.json written by scripts/fetch-assets.ts next to the library files. */
export interface LibraryIndex {
  version: number;
  /** `res`: the sizes on disk in pixels, smallest first. */
  textures: Record<string, { size: [number, number]; maps: string[]; res: number[] }>;
  models: Record<string, { size: [number, number, number]; front?: number }>;
  hdris: Record<string, { sun: [number, number, number] }>;
}

/** Largest texture size for anything but floors, and on phones; floors are seen closest. */
export const NON_FLOOR_MAX = 1024;

/** An HDRI as the stage loads it: a small lighting copy, the full sky, and where its sun is. */
export interface HdriSet {
  env: string;
  sky: string;
  sun: [number, number, number];
}


/**
 * The shared asset library served as static files. Plans refer to it with paths that start
 * with "@lib/", e.g. "@lib/models/side_table_01.glb"; anything else resolves against the plan URL.
 */
export class Library {
  readonly base: string;
  private index: LibraryIndex;
  private planUrl: string | undefined;

  static async load(base: string, planUrl?: string, signal?: AbortSignal) {
    const root = base.endsWith('/') ? base : `${base}/`;
    const url = new URL('index.json', new URL(root, location.href));
    const res = await (takePrefetched(url) ?? fetch(url, { signal }));
    if (!res.ok) throw new Error(`Viewer library index not found at ${root}index.json (${res.status}). Run bun run fetch-assets.`);
    const index = (await res.json()) as LibraryIndex;
    if (!index.version) throw new Error(`Viewer library at ${root} is in the old layout. Run bun run fetch-assets.`);
    return new Library(new URL(root, location.href).href, index, planUrl);
  }

  private constructor(base: string, index: LibraryIndex, planUrl?: string) {
    this.base = base;
    this.index = index;
    this.planUrl = planUrl && new URL(planUrl, location.href).href;
  }

  resolve = (rel: string): string | undefined => {
    if (rel.startsWith('@lib/')) return this.base + rel.slice(5);
    return this.planUrl ? new URL(rel.replace(/^\.\//, ''), this.planUrl).href : undefined;
  };

  /**
   * `full` is the largest size up to `max` px. With `progressive` the smallest maps paint first and
   * `full` streams in after; without it `full` loads directly, one download per map.
   */
  texture = (id: string, max = Infinity, progressive = true): PbrSet | undefined => {
    const meta = this.index.textures[id];
    if (!meta?.res?.length) return undefined;
    const top = meta.res.filter((r) => r <= max).at(-1) ?? meta.res[0];
    const maps = (r: number) => {
      const url = (m: string) => (meta.maps.includes(m) ? this.url(`textures/${id}/${r}/${m}.webp`) : undefined);
      return { color: url('color'), normal: url('normal'), orm: url('orm') };
    };
    return { size: meta.size, first: maps(progressive ? meta.res[0] : top), full: maps(top) };
  };

  /** Versioned so a long browser cache stays correct after fetch-assets rebuilds the files. */
  private url(rel: string) {
    return `${this.base}${rel}?v=${this.index.version}`;
  }

  model = (path: string): ModelInfo => {
    if (!path.startsWith('@lib/models/')) return { url: this.resolve(path), front: 0 };
    const id = path.replace(/^@lib\/models\//, '').replace(/\.glb$/, '');
    const meta = this.index.models[id];
    return { url: meta ? this.url(`models/${id}.glb`) : undefined, front: meta?.front ?? 0 };
  };

  hdri(id: string): HdriSet | undefined {
    const meta = this.index.hdris[id];
    return meta && { env: this.url(`hdri/${id}-env.hdr`), sky: this.url(`hdri/${id}.hdr`), sun: meta.sun };
  }
}
