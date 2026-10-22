import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pieceCategory, type PieceCategory } from "@arch/viewer/plan/categories";
import { z } from "zod";
import { shrinkPng } from "./png.ts";
import { convertUsdAsset } from "./usd.ts";

/**
 * NVIDIA SimReady, a CC BY 4.0 library of OpenUSD props on Hugging Face
 * (https://huggingface.co/datasets/nvidia/simready-assets). SimReady Central
 * (https://huggingface.co/spaces/nvidia/simready-central) searches it by text and picture.
 * Searching needs Central; importing reads the dataset directly, so an asset ID is enough.
 */

const DATASET = "nvidia/simready-assets";
const HUB = "https://huggingface.co";
const CENTRAL = "https://nvidia-simready-central.hf.space";
const LICENSE = "CC-BY-4.0";
/** An asset folder in the dataset, such as `sofa_soft_b01`. */
export const simReadyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const revision = z.string().regex(/^[0-9a-f]{40}$/);
const rootLayer = z.string().regex(/^[A-Za-z0-9_.-]+\.usd[ac]?$/);
/** What an asset folder may hold at most; layers and the textures used, before conversion. */
const MAX_DOWNLOAD = 200 * 1024 * 1024;
const TIMEOUT = 60_000;

/** A SimReady asset a search found. */
export interface SimReadyAsset {
  id: string;
  name: string;
  /** Wikidata class the asset carries, such as "couch". */
  label: string | null;
  category: PieceCategory;
  /** [width, depth, height] in metres, front facing the viewer's +z. */
  size: [number, number, number] | null;
  license: string;
  /** Dataset commit and root layer file, which locate its preview picture. */
  revision: string;
  root: string;
}

/** "sofa_soft_b01" reads "Sofa soft B01"; "chair_office_amf_black_a01" reads "Chair office amf black A01". */
export function simReadyName(id: string) {
  const words = id.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[_\s-]+/).filter(Boolean);
  const last = words.at(-1);
  if (last && /^[a-z]\d+$/.test(last)) words[words.length - 1] = last.toUpperCase();
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Hugging Face and its file CDNs, the only hosts a request or its redirects may reach. */
const trusted = (url: URL) => url.protocol === "https:" && /(^|\.)(huggingface\.co|hf\.co|hf\.space|xethub\.hf\.co)$/.test(url.hostname);

/**
 * The body of a request to Hugging Face, at most `maxBytes` long. Redirects are followed only to
 * Hugging Face hosts over HTTPS, so a response can never point Studio at a local service.
 */
async function fetchBytes(url: string, maxBytes: number, { signal, ...init }: RequestInit & { signal?: AbortSignal } = {}): Promise<{ bytes: Uint8Array; type: string }> {
  const timeout = AbortSignal.timeout(TIMEOUT);
  let target = new URL(url);
  let response: Response | undefined;
  for (let hop = 0; hop < 6; hop++) {
    if (!trusted(target)) throw new Error(`Refusing to fetch ${target.host}: only Hugging Face is reached.`);
    response = await fetch(target, { ...init, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { "User-Agent": "Arch Studio", ...init.headers } });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) break;
    target = new URL(location, target);
    if (init.method && init.method !== "GET") throw new Error(`Unexpected redirect from ${new URL(url).host}.`);
  }
  if (!response?.ok) throw new Error(`${response?.status ?? "No"} ${response?.statusText ?? "response"} from ${target.host}`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error(`${target.host} sent more than ${maxBytes} bytes.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > maxBytes) throw new Error(`${target.host} sent more than ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  chunks.reduce((at, chunk) => {
    bytes.set(chunk, at);
    return at + chunk.length;
  }, 0);
  return { bytes, type: response.headers.get("content-type") ?? "" };
}
const MB = 1024 * 1024;
const fetchJson = async (url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<unknown> => JSON.parse(new TextDecoder().decode((await fetchBytes(url, 8 * MB, init)).bytes));

const hit = z.object({
  source: z.object({
    path: z.string(),
    usd_dimensions: z.record(z.string(), z.unknown()).optional(),
    usd_properties: z.array(z.object({ name: z.string(), value: z.unknown().optional() }).passthrough()).optional(),
  }).passthrough(),
}).passthrough();
const searchResponse = z.object({ hits: z.array(hit), next_cursor: z.string().nullish(), has_more: z.boolean().optional() }).passthrough();
const assetPath = /^hf:\/\/huggingface\.co\/datasets\/nvidia\/simready-assets\/resolve\/([0-9a-f]{40})\/([A-Za-z0-9][A-Za-z0-9_-]{0,119})\/simready_usd\/([A-Za-z0-9_.-]+\.usd[ac]?)$/;

/** [width, depth, height] from Central's bounding box. SimReady props stand on z and face +x. */
function footprint(dimensions: Record<string, unknown> | undefined): SimReadyAsset["size"] {
  if (!dimensions) return null;
  const number = (key: string) => (typeof dimensions[key] === "number" ? (dimensions[key] as number) : NaN);
  const unit = Number.isFinite(number("scene_mpu")) ? number("scene_mpu") : 1;
  const [x, y, z] = ["x", "y", "z"].map((axis) => number(`scaled_bbox_dimension_${axis}`) * unit) as [number, number, number];
  const size: [number, number, number] = dimensions.scene_up_axis === "Y" ? [z, x, y] : [y, x, z];
  return size.every((value) => Number.isFinite(value) && value > 0) ? size.map((value) => Math.round(value * 1000) / 1000) as [number, number, number] : null;
}

/**
 * SimReady assets that match a description, best first, from SimReady Central's text and image
 * search. Only `nvidia/simready-assets` results count; `cursor` continues a previous search.
 */
export async function searchSimReady(query: string, { limit = 24, cursor, signal }: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}): Promise<{ assets: SimReadyAsset[]; cursor: string | null }> {
  const text = query.trim().slice(0, 200) || "furniture";
  const body = {
    hybrid_text_query: text,
    vector_queries: [{ field_name: "siglip2-embedding.embedding", query_type: "text", query: text }],
    file_extension_include: "usd*",
    // Central also indexes other datasets; ask for more and keep NVIDIA's.
    limit: Math.min(100, Math.max(1, limit) * 2),
    ...(cursor ? { cursor } : {}),
    return_usd_dimensions: true,
    return_usd_properties: true,
    return_images: false,
    return_metadata: false,
  };
  const response = searchResponse.parse(await fetchJson(`${CENTRAL}/search_hybrid`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal }));
  const assets: SimReadyAsset[] = [];
  const seen = new Set<string>();
  for (const { source } of response.hits) {
    const match = assetPath.exec(source.path);
    if (!match || seen.has(match[2]!)) continue;
    const [, commit, id, root] = match as unknown as [string, string, string, string];
    const property = (name: string) => {
      const value = source.usd_properties?.find((item) => item.name === name)?.value;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    };
    const license = property("simready_metadata_asset_license") ?? LICENSE;
    if (license.replace(/[\s-]+/g, "").toUpperCase() !== "CCBY4.0") continue;
    const label = property("semantic:wikidata_class:params:semanticData");
    seen.add(id);
    assets.push({ id, name: simReadyName(id), label, category: pieceCategory(label, id), size: footprint(source.usd_dimensions), license: LICENSE, revision: commit, root });
    if (assets.length >= limit) break;
  }
  return { assets, cursor: response.has_more === false ? null : (response.next_cursor ?? null) };
}

/** Central's preview picture of an asset, a JPEG of about 40 KB. */
export async function simReadyPreview(asset: { id: string; revision: string; root: string }, signal?: AbortSignal): Promise<Uint8Array> {
  const key = `${HUB}/datasets/${DATASET}/blob/${revision.parse(asset.revision)}/${simReadyId.parse(asset.id)}/simready_usd/${rootLayer.parse(asset.root)}`;
  const { bytes, type } = await fetchBytes(`${CENTRAL}/images?${new URLSearchParams({ asset_url: key })}`, 4 * MB, { signal });
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error("SimReady Central sent no picture.");
  return bytes;
}

const bomSchema = z.object({ items: z.array(z.object({ relative_path: z.string(), size: z.number().int().nonnegative(), hash: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).passthrough() }).passthrough()) }).passthrough();

/** The files of one asset folder at one dataset commit, each checked against the package's bill of materials. */
async function assetFolder(id: string, signal?: AbortSignal) {
  simReadyId.parse(id);
  const commit = revision.parse((await fetchJson(`${HUB}/api/datasets/${DATASET}/revision/main?expand%5B%5D=sha`, { signal }) as { sha?: string }).sha);
  const url = (file: string) => `${HUB}/datasets/${DATASET}/resolve/${commit}/${id}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const packaging = z.object({ license: z.string() }).passthrough().parse(await fetchJson(url("com.nvidia.simready.packaging.json"), { signal }));
  if (packaging.license !== LICENSE) throw new Error(`SimReady asset ${id} is licensed ${packaging.license}, not ${LICENSE}.`);
  const bom = new Map(bomSchema.parse(await fetchJson(url(".metadata/com.nvidia.simready.packaging.bom.json"), { signal })).items.map((item) => [item.relative_path, item]));
  let downloaded = 0;
  return {
    commit,
    has: (file: string) => bom.has(file),
    files: () => [...bom.keys()],
    size: (file: string) => bom.get(file)?.size ?? Infinity,
    async read(file: string) {
      const item = bom.get(file);
      if (!item) throw new Error(`SimReady asset ${id} lists no ${file}.`);
      downloaded += item.size;
      if (downloaded > MAX_DOWNLOAD) throw new Error(`SimReady asset ${id} is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB.`);
      const { bytes } = await fetchBytes(url(file), item.size, { signal });
      if (bytes.length !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.hash.sha256) throw new Error(`SimReady asset ${id}: ${file} does not match its package hash.`);
      return bytes;
    },
  };
}

/** Physics variants, which change nothing the viewer draws. */
const PHYSICS = /(^|\/)(Physics|PhysX|MuJoCo|Newton)\//;

/** A converted SimReady asset, ready to join a library folder. */
export interface SimReadyModel {
  id: string;
  name: string;
  label: string | null;
  category: PieceCategory;
  glb: Uint8Array;
  size: [number, number, number];
  triangles: number;
  /** Picture of the asset for pickers, a JPEG or PNG. */
  thumbnail: Uint8Array | null;
  /** One CREDITS.md line naming the asset, its author, licence and source. */
  credit: string;
  source: string;
}

/**
 * Downloads one SimReady asset and converts it for the viewer: its look layers composed into one
 * glTF at real size with its front turned to +z, materials with 256 px textures (the package's own
 * previews, or its maps shrunk), and geometry simplified to about 40,000 triangles. Physics layers are left out.
 */
export async function convertSimReadyAsset(id: string, { preview, signal }: { preview?: { revision: string; root: string }; signal?: AbortSignal } = {}): Promise<SimReadyModel> {
  const folder = await assetFolder(id, signal);
  const base = "simready_usd/payloads/base.usda";
  if (!folder.has(base)) throw new Error(`SimReady asset ${id} has no ${base}; only packaged SimReady props can be imported.`);
  const layers = new Map<string, Uint8Array>();
  const pending = [base];
  while (pending.length) {
    const file = pending.shift()!;
    if (layers.has(file)) continue;
    const bytes = await folder.read(file);
    layers.set(file, bytes);
    if (new TextDecoder().decode(bytes.subarray(0, 8)) === "PXR-USDC") continue;
    for (const [, reference] of new TextDecoder().decode(bytes).matchAll(/@(\.{1,2}\/[^@]+?\.usd[ac]?)@/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference!));
      if (!PHYSICS.test(next) && folder.has(next) && !layers.has(next)) pending.push(next);
    }
  }
  const model = await convertUsdAsset({
    root: base,
    layers,
    async texture(file) {
      // The package's own previews keep a prop's textures small enough for a project; without
      // one, a map up to 8 MB is shrunk here and a larger one is left out for its material's colour.
      const preview = (size: number) => `${path.posix.dirname(file)}/.thumbs/${size}x${size}/${path.posix.basename(file)}.png`;
      if (folder.has(preview(256))) return folder.read(preview(256));
      const source = folder.has(preview(512)) ? preview(512) : file;
      if (!/\.png$/i.test(source) || folder.size(source) > 8 * 1024 * 1024) return undefined;
      return shrinkPng(await folder.read(source), 256) ?? undefined;
    },
  }, { turn: 90 });
  // Central's preview is a tenth the size of the package's own picture; either will do.
  const picture = folder.files().find((file) => /^simready_usd\/\.thumbs\/[^/]+_thumbnail\.png$/.test(file));
  const thumbnail = (preview && await simReadyPreview({ id, ...preview }, signal).catch(() => null)) ?? (picture ? await folder.read(picture) : null);
  const label = /semantics:labels:wikidata_class = \["([^"]+)"\]/.exec(new TextDecoder().decode(layers.get(base)!))?.[1] ?? null;
  const source = `${HUB}/datasets/${DATASET}/tree/${folder.commit}/${id}`;
  const name = simReadyName(id);
  return { id, name, label, category: pieceCategory(label, id), ...model, thumbnail, source, credit: `- ${name} (model), NVIDIA SimReady, CC BY 4.0, ${source}` };
}

/** Writes bytes beside their final name and renames them into place. */
export async function writeAtomically(file: string, bytes: Uint8Array | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  await fs.rename(temporary, file);
}
