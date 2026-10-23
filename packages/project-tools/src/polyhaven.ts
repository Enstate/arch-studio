import { createHash } from "node:crypto";
import { materialCategory, type MaterialCategory } from "@arch/viewer/plan/categories";
import { z } from "zod";
import { fetchCapped, MB } from "./remote.ts";

/**
 * Poly Haven's CC0 texture sets (https://polyhaven.com/textures): floors, walls, stone, wood,
 * fabric. Search reads Poly Haven's listing; an import downloads one set's 1K maps, which the
 * viewer loads as a library texture.
 */

const API = "https://api.polyhaven.com";
const polyHaven = (url: URL) => /(^|\.)polyhaven\.(com|org)$/.test(url.hostname);
const fetchJson = async (url: string, signal?: AbortSignal): Promise<unknown> => JSON.parse(new TextDecoder().decode((await fetchCapped(url, 16 * MB, polyHaven, { signal })).bytes));
/** A Poly Haven asset ID, such as `laminate_floor_02`. */
export const polyHavenId = z.string().regex(/^[a-z0-9][a-z0-9_]{0,119}$/);

/** A texture set a search found. */
export interface PolyHavenTexture {
  id: string;
  name: string;
  category: MaterialCategory;
  /** Metres one repeat covers, [width, depth]. */
  size: [number, number];
}

const listingSchema = z.record(z.string(), z.object({ name: z.string(), categories: z.array(z.string()).default([]), tags: z.array(z.string()).default([]), dimensions: z.array(z.number()).optional(), thumbnail_url: z.string().optional() }).passthrough());
let listing: { at: number; textures: Promise<z.infer<typeof listingSchema>> } | null = null;
/** Poly Haven's whole texture listing, kept for an hour. */
function textures(signal?: AbortSignal) {
  if (!listing || Date.now() - listing.at > 3_600_000) {
    const textures = fetchJson(`${API}/assets?t=textures`, signal).then((json) => listingSchema.parse(json));
    listing = { at: Date.now(), textures };
    textures.catch(() => (listing = null));
  }
  return listing.textures;
}

/** Metres from Poly Haven's dimensions in millimetres; 2 m when it gives none. */
const metres = (dimensions?: number[]): [number, number] => (dimensions?.length === 2 ? [dimensions[0]! / 1000, dimensions[1]! / 1000] : [2, 2]);

/**
 * Texture sets whose name, tags or categories hold every word, in Poly Haven's order. Aerial and
 * terrain scans, meant for landscapes seen from far away, are left out.
 */
export async function searchPolyHaven(query: string, { category, limit = 24, signal }: { category?: MaterialCategory; limit?: number; signal?: AbortSignal } = {}): Promise<PolyHavenTexture[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found: PolyHavenTexture[] = [];
  for (const [id, asset] of Object.entries(await textures(signal))) {
    if (asset.categories.includes("aerial") || asset.categories.includes("terrain") || !polyHavenId.safeParse(id).success) continue;
    const kind = materialCategory(asset.categories.filter((c) => !["man made", "natural", "indoor", "outdoor", "clean", "dirty"].includes(c)).join(" "), id);
    if (category && kind !== category) continue;
    const text = `${id} ${asset.name} ${asset.tags.join(" ")} ${asset.categories.join(" ")}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) continue;
    found.push({ id, name: asset.name, category: kind, size: metres(asset.dimensions) });
    if (found.length >= limit) break;
  }
  return found;
}

/** Poly Haven's preview picture of a texture set, a WebP of a few kilobytes. */
export async function polyHavenPreview(id: string, signal?: AbortSignal): Promise<Uint8Array> {
  const url = (await textures(signal))[polyHavenId.parse(id)]?.thumbnail_url;
  if (!url) throw new Error(`Poly Haven has no texture ${id}.`);
  return (await fetchCapped(url, 2 * MB, polyHaven, { signal })).bytes;
}

const fileSchema = z.object({ url: z.string(), size: z.number(), md5: z.string().regex(/^[0-9a-f]{32}$/) }).passthrough();
const filesSchema = z.record(z.string(), z.unknown());

/** A texture set as the library keeps it: its maps' bytes and its index entry. */
export interface PolyHavenSet {
  id: string;
  name: string;
  category: MaterialCategory;
  size: [number, number];
  /** JPEG bytes of the colour, normal (OpenGL) and occlusion-roughness-metal maps that exist, at 1024 px. */
  maps: Partial<Record<"color" | "normal" | "orm", Uint8Array>>;
  credit: string;
}

/** Downloads one texture set's 1K maps, each checked against Poly Haven's MD5. */
export async function downloadPolyHavenTexture(id: string, signal?: AbortSignal): Promise<PolyHavenSet> {
  polyHavenId.parse(id);
  const asset = (await textures(signal))[id];
  if (!asset) throw new Error(`Poly Haven has no texture ${id}.`);
  const files = filesSchema.parse(await fetchJson(`${API}/files/${id}`, signal));
  const map = async (key: string) => {
    const file = fileSchema.safeParse((files[key] as Record<string, Record<string, unknown>> | undefined)?.["1k"]?.jpg);
    if (!file.success) return undefined;
    const { bytes } = await fetchCapped(file.data.url, Math.min(file.data.size, 32 * MB), polyHaven, { signal });
    if (createHash("md5").update(bytes).digest("hex") !== file.data.md5) throw new Error(`Poly Haven texture ${id}: ${key} does not match its checksum.`);
    return bytes;
  };
  const [color, normal, orm] = await Promise.all([map("Diffuse"), map("nor_gl"), map("arm")]);
  if (!color) throw new Error(`Poly Haven texture ${id} has no colour map at 1K.`);
  const kind = materialCategory(asset.categories.filter((c) => !["man made", "natural", "indoor", "outdoor", "clean", "dirty"].includes(c)).join(" "), id);
  return {
    id,
    name: asset.name,
    category: kind,
    size: metres(asset.dimensions),
    maps: { color, ...(normal && { normal }), ...(orm && { orm }) },
    credit: `- ${asset.name} (texture), Poly Haven, CC0, https://polyhaven.com/a/${id}`,
  };
}
