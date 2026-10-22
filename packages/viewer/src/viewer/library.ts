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

  /**
   * `catalog` is the full shared library, for hand editing: models and textures a project has not
   * bundled yet load from there until a build bundles them.
   */
  static async load(base: string, planUrl?: string, signal?: AbortSignal, catalog?: string): Promise<Library> {
    const root = base.endsWith('/') ? base : `${base}/`;
    const url = new URL('index.json', new URL(root, location.href));
    const res = await (takePrefetched(url) ?? fetch(url, { signal }));
    if (!res.ok) throw new Error(`Viewer library index not found at ${root}index.json (${res.status}). Run bun run fetch-assets.`);
    const index = (await res.json()) as LibraryIndex;
    if (!index.version) throw new Error(`Viewer library at ${root} is in the old layout. Run bun run fetch-assets.`);
    const shared: Library | undefined = catalog && new URL(catalog, location.href).href !== new URL(root, location.href).href ? await Library.load(catalog, undefined, signal) : undefined;
    return new Library(new URL(root, location.href).href, index, planUrl, shared);
  }

  /** The shared library behind this one, when hand editing may use more of it. */
  readonly catalog: Library | undefined;

  private constructor(base: string, index: LibraryIndex, planUrl?: string, catalog?: Library) {
    this.base = base;
    this.index = index;
    this.planUrl = planUrl && new URL(planUrl, location.href).href;
    this.catalog = catalog;
  }

  /** Everything the library holds, for a catalog of pieces and finishes. */
  get contents(): Readonly<LibraryIndex> {
    return this.index;
  }

  /** Reads the shared library's index again, so assets that joined it since loading can be placed. */
  async reloadCatalog(signal?: AbortSignal): Promise<void> {
    if (!this.catalog) return;
    const res = await fetch(new URL('index.json', this.catalog.base), { cache: 'no-store', signal });
    if (!res.ok) throw new Error(`Viewer library index not found at ${this.catalog.base}index.json (${res.status}).`);
    this.catalog.index = (await res.json()) as LibraryIndex;
  }

  resolve = (rel: string): string | undefined => {
    if (rel.startsWith('@lib/models/') && this.catalog && !this.index.models[rel.slice(12).replace(/\.glb$/, '')]) return this.catalog.resolve(rel);
    if (rel.startsWith('@lib/')) return this.base + rel.slice(5);
    return this.planUrl ? new URL(rel.replace(/^\.\//, ''), this.planUrl).href : undefined;
  };

  /** A small colour swatch of a texture set, for pickers. */
  swatch(id: string): string | undefined {
    const meta = this.index.textures[id];
    if (!meta?.res?.length || !meta.maps.includes('color')) return this.catalog?.swatch(id);
    return this.url(`textures/${id}/${meta.res[0]}/color.webp`);
  }

  /**
   * `full` is the largest size up to `max` px. With `progressive` the smallest maps paint first and
   * `full` streams in after; without it `full` loads directly, one download per map.
   */
  texture = (id: string, max = Infinity, progressive = true): PbrSet | undefined => {
    const meta = this.index.textures[id];
    if (!meta?.res?.length) return this.catalog?.texture(id, max, progressive);
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
    if (!meta && this.catalog) return this.catalog.model(path);
    return { url: meta ? this.url(`models/${id}.glb`) : undefined, front: meta?.front ?? 0 };
  };

  hdri(id: string): HdriSet | undefined {
    const meta = this.index.hdris[id];
    return meta && { env: this.url(`hdri/${id}-env.hdr`), sky: this.url(`hdri/${id}.hdr`), sun: meta.sun };
  }
}
