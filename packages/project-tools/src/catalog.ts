import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pieceCategory, type PieceCategory } from "@arch/viewer/plan/categories";
import { z } from "zod";
import { studioStoreDirectory } from "./index.ts";
import { convertSimReadyAsset, simReadyId, writeAtomically } from "./simready.ts";

/**
 * The asset catalog hand editing and agents choose from. It is two library folders with the
 * viewer's layout (`index.json`, `models/`, `textures/`): the shared CC0 library `bun run
 * fetch-assets` fills, and the store's own `library/`, where imported SimReady assets go. Entries
 * may carry `name`, `category`, `label`, `thumbnail` (a file in the folder) and `credit`, which the
 * viewer ignores. The first folder that holds an ID wins.
 */

export interface CatalogModel {
  /** Library ID: `@lib/models/<id>.glb` places it. */
  id: string;
  name: string;
  category: PieceCategory;
  /** [width, depth, height] in metres. */
  size: [number, number, number];
  source: "library" | "simready";
  /** What the asset is, in its source's words, such as "couch". */
  label?: string;
  /** Picture of the asset, relative to the catalog. */
  thumbnail?: string;
  /** CREDITS.md line a project delivering it keeps. */
  credit?: string;
}

export interface CatalogTexture {
  id: string;
  name: string;
  /** Metres one repeat covers. */
  size: [number, number];
}

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const triple = z.tuple([z.number(), z.number(), z.number()]);
const modelEntry = z.object({
  size: triple,
  front: z.number().optional(),
  name: z.string().optional(),
  category: z.string().optional(),
  label: z.string().nullish(),
  thumbnail: z.string().regex(/^thumbs\/[A-Za-z0-9_.-]+$/).optional(),
  credit: z.string().optional(),
  source: z.string().optional(),
}).passthrough();
const indexSchema = z.object({
  version: z.number().int().positive(),
  textures: z.record(id, z.object({ size: z.tuple([z.number(), z.number()]), res: z.array(z.number()), maps: z.array(z.string()) }).passthrough()),
  models: z.record(id, z.unknown()),
  hdris: z.record(id, z.unknown()),
}).passthrough();
export type CatalogIndex = z.infer<typeof indexSchema>;

/** Where this store keeps imported assets, as a library folder. */
export function storeLibraryDirectory() {
  return path.join(studioStoreDirectory(), "library");
}

/**
 * The shared CC0 library: `ARCH_LIBRARY` when set, beside the packaged Studio client, or what
 * `bun run fetch-assets` wrote into this checkout. Null when there is none.
 */
export function sharedLibraryDirectory(): string | null {
  if (process.env.ARCH_LIBRARY && !path.isAbsolute(process.env.ARCH_LIBRARY)) throw new Error("ARCH_LIBRARY must be absolute.");
  const candidates = [
    process.env.ARCH_LIBRARY,
    process.env.ARCH_CLIENT_ROOT && path.join(process.env.ARCH_CLIENT_ROOT, "viewer/library"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/studio/public/viewer/library"),
  ];
  return candidates.find((directory): directory is string => !!directory && existsSync(path.join(directory, "index.json"))) ?? null;
}

/** The catalog folders in lookup order: the store's imports, then the shared library. */
export function catalogFolders(): string[] {
  const shared = sharedLibraryDirectory();
  return [storeLibraryDirectory(), ...(shared ? [shared] : [])];
}

async function folderIndex(folder: string): Promise<CatalogIndex | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(folder, "index.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return indexSchema.parse(JSON.parse(text));
}

const humanize = (value: string) => value.replace(/[_-]+/g, " ").replace(/\s\d+$/, "").replace(/^\w/, (c) => c.toUpperCase());

/** Every model and texture the folders hold, first folder first. */
export async function assetCatalog(folders = catalogFolders()): Promise<{ models: CatalogModel[]; textures: CatalogTexture[] }> {
  const models = new Map<string, CatalogModel>();
  const textures = new Map<string, CatalogTexture>();
  for (const folder of folders) {
    const index = await folderIndex(folder);
    if (!index) continue;
    for (const [key, value] of Object.entries(index.models)) {
      const entry = modelEntry.safeParse(value);
      if (models.has(key) || !entry.success) continue;
      const { name, category, label, thumbnail, credit, source, size } = entry.data;
      models.set(key, {
        id: key,
        name: name ?? humanize(key),
        category: (category as PieceCategory | undefined) ?? pieceCategory(label, key),
        size,
        source: source === "simready" ? "simready" : "library",
        ...(label && { label }),
        ...(thumbnail && { thumbnail }),
        ...(credit && { credit }),
      });
    }
    for (const [key, value] of Object.entries(index.textures)) if (!textures.has(key)) textures.set(key, { id: key, name: humanize(key), size: value.size });
  }
  return { models: [...models.values()], textures: [...textures.values()] };
}

/** One index over the folders, the shape the viewer loads, so the catalog can be served as one library. */
export async function catalogIndex(folders = catalogFolders()): Promise<CatalogIndex> {
  const merged: CatalogIndex = { version: 2, textures: {}, models: {}, hdris: {} };
  for (const index of (await Promise.all(folders.map(folderIndex))).reverse()) {
    if (!index) continue;
    merged.version = Math.max(merged.version, index.version);
    Object.assign(merged.textures, index.textures);
    Object.assign(merged.models, index.models);
    Object.assign(merged.hdris, index.hdris);
  }
  return merged;
}

/**
 * The file behind a catalog path such as `models/<id>.glb` or `thumbs/<id>.png`, from the first
 * folder whose index holds it. Null for anything else, and for paths that leave the folder.
 */
export async function catalogFile(relative: string, folders = catalogFolders()): Promise<string | null> {
  const parts = relative.split("/");
  if (!relative || relative.includes("\\") || parts.some((part) => !part || part.startsWith("."))) return null;
  for (const folder of folders) {
    const index = await folderIndex(folder);
    if (!index) continue;
    const [kind, name] = parts;
    const holds = kind === "models" ? !!index.models[name!.replace(/\.glb$/, "")]
      : kind === "textures" ? !!index.textures[name!]
      : kind === "hdri" ? !!index.hdris[name!.replace(/(-env)?\.hdr$/, "")]
      : kind === "thumbs";
    if (!holds) continue;
    const file = path.join(folder, ...parts);
    try {
      const real = await fs.realpath(file);
      if (real.startsWith((await fs.realpath(folder)) + path.sep) && (await fs.stat(real)).isFile()) return real;
    } catch {
      // Listed but missing: try the next folder.
    }
  }
  return null;
}

/** The library ID an imported SimReady asset takes. */
export const simReadyLibraryId = (asset: string) => `simready_${simReadyId.parse(asset)}`;

let imports: Promise<unknown> = Promise.resolve();

/**
 * Runs `change` while holding the library's lock file, so a CLI import and Studio never rewrite its
 * index at the same time. A lock older than ten minutes belongs to a process that died.
 */
export async function withLibraryLock<T>(library: string, change: () => Promise<T>): Promise<T> {
  await fs.mkdir(library, { recursive: true });
  const lock = path.join(library, ".index.lock");
  for (const started = Date.now(); ;) {
    try {
      await (await fs.open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await fs.stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > 600_000) await fs.rm(lock, { force: true });
      else if (Date.now() - started > 60_000) throw new Error(`The library at ${library} stayed locked for a minute.`);
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await change();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/**
 * Brings a SimReady asset into the store's library, once: converted, with its thumbnail and credit,
 * so hand editing and agents can place it as `@lib/models/simready_<asset>.glb`. Imports in one
 * process run one at a time, the index is written under the library's lock, and an asset already
 * there returns at once.
 */
export function importSimReady(asset: string, { library = storeLibraryDirectory(), preview, signal }: { library?: string; preview?: { revision: string; root: string }; signal?: AbortSignal } = {}): Promise<CatalogModel> {
  const libraryId = simReadyLibraryId(asset);
  const run = async () => {
    const existing = (await assetCatalog([library])).models.find((model) => model.id === libraryId);
    if (existing) return existing;
    const model = await convertSimReadyAsset(asset, { preview, signal });
    await writeAtomically(path.join(library, "models", `${libraryId}.glb`), model.glb);
    const jpeg = model.thumbnail?.[0] === 0xff && model.thumbnail[1] === 0xd8;
    const thumbnail = model.thumbnail ? `thumbs/${libraryId}.${jpeg ? "jpg" : "png"}` : undefined;
    if (model.thumbnail) await writeAtomically(path.join(library, thumbnail!), model.thumbnail);
    await withLibraryLock(library, async () => {
      const index = (await folderIndex(library)) ?? { version: 2, textures: {}, models: {}, hdris: {} };
      index.models[libraryId] = { size: model.size, front: 0, name: model.name, category: model.category, ...(model.label && { label: model.label }), ...(thumbnail && { thumbnail }), credit: model.credit, source: "simready", url: model.source };
      await writeAtomically(path.join(library, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
      const credits = path.join(library, "CREDITS.md");
      const previous = await fs.readFile(credits, "utf8").catch(() => "# Asset credits\n\nAssets imported into this Arch Studio library. NVIDIA SimReady assets are licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) and need this attribution wherever they are delivered.\n\n");
      if (!previous.includes(model.credit)) await writeAtomically(credits, `${previous}${model.credit}\n`);
    });
    return (await assetCatalog([library])).models.find((item) => item.id === libraryId)!;
  };
  const next = imports.then(run, run);
  imports = next.catch(() => undefined);
  return next;
}
