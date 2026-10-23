import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assetCatalog, catalogFile, catalogFolders, catalogIndex, importSimReady, simReadyLibraryId, storeLibraryDirectory } from "@arch/project-tools/catalog";
import { searchSimReady, simReadyPreview, writeAtomically } from "@arch/project-tools/simready";
import type { CatalogPiece, RemotePiece } from "@arch/viewer-ui";
import { requireStudio, studioOrigin } from "./local-session";
import { recordFailure } from "./studio-log.server";

/**
 * The asset catalog hand editing offers: the shared library and this store's imports, served as
 * one library at a capability URL, and NVIDIA SimReady, searched through SimReady Central and
 * imported on request. Catalog files are public assets, but the URL still follows the artifact
 * rules: loopback, exact origin and a per-process token.
 */

// Kept across development module reloads, so catalog URLs an open viewer holds stay valid.
const processState = globalThis as typeof globalThis & { archCatalogKey?: Buffer };
processState.archCatalogKey ??= randomBytes(32);
const catalogKey = processState.archCatalogKey;
const token = () => createHmac("sha256", catalogKey).update("catalog").digest("hex");
const base = (origin: string) => `${origin}/api/catalog/${token()}/`;
const SIMREADY = "NVIDIA SimReady";
/** A found SimReady asset: dataset commit, asset folder and root layer. */
export const simReadyKey = /^[0-9a-f]{40}\/[A-Za-z0-9][A-Za-z0-9_-]{0,119}\/[A-Za-z0-9_.-]+\.usd[ac]?$/;

const piece = (model: Awaited<ReturnType<typeof assetCatalog>>["models"][number]): CatalogPiece => ({
  id: model.id,
  name: model.name,
  category: model.category,
  size: model.size,
  source: model.source === "simready" ? "SimReady" : undefined,
  ...(model.credit && { credit: model.credit.replace(/^- /, "") }),
});

/** Where the viewer loads the catalog from, and what each of its models is. */
export async function assetLibrary() {
  const origin = requireStudio();
  const { models } = await assetCatalog();
  return { base: base(origin), pieces: models.map(piece) };
}

/** SimReady assets matching a description, with previews served through this Studio. */
export async function searchAssets({ data }: { data: { query: string } }): Promise<RemotePiece[]> {
  const origin = requireStudio();
  const { assets } = await searchSimReady(data.query, { limit: 24 });
  return assets.map(asset => ({
    key: [asset.revision, asset.id, asset.root].join("/"),
    name: asset.name,
    category: asset.category,
    source: SIMREADY,
    license: "CC BY 4.0",
    ...(asset.size && { size: asset.size }),
    libraryId: simReadyLibraryId(asset.id),
    thumbnail: `${base(origin)}simready/${asset.revision}/${asset.id}/${asset.root}`,
  }));
}

/** Imports a SimReady asset a search found into this store's catalog. */
export async function importAsset({ data }: { data: { key: string } }): Promise<CatalogPiece> {
  requireStudio();
  return piece(await importSimReady(data.key.split("/")[1]!));
}

const types: Record<string, string> = { ".json": "application/json", ".glb": "model/gltf-binary", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".hdr": "image/vnd.radiance" };

/** Serves `index.json` over every catalog folder, their files, and SimReady previews. */
export async function catalogResponse(request: Request, capability: string, relative: string) {
  try {
    const exactOrigin = studioOrigin(request);
    if (!/^[a-f0-9]{64}$/.test(capability) || !timingSafeEqual(Buffer.from(capability), Buffer.from(token()))) return new Response(null, { status: 404 });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    let body: Uint8Array;
    let type: string;
    let cache = "private, no-cache";
    const parts = relative.split("/");
    if (relative === "index.json") {
      body = new TextEncoder().encode(JSON.stringify(await catalogIndex()));
      type = types[".json"]!;
      cache = "no-store";
    } else if (parts[0] === "simready" && parts.length === 4) {
      // Previews are kept, so a picture is fetched from Central once.
      const [, revision, id, root] = parts as [string, string, string, string];
      if (!simReadyKey.test(`${revision}/${id}/${root}`)) return new Response(null, { status: 404 });
      const file = path.join(storeLibraryDirectory(), "previews", `${revision}-${id}.jpg`);
      body = await fs.readFile(file).catch(async () => {
        const fetched = await simReadyPreview({ id, revision, root });
        await writeAtomically(file, fetched);
        return fetched;
      });
      type = types[".jpg"]!;
      cache = "private, max-age=604800";
    } else {
      const file = await catalogFile(relative, catalogFolders());
      type = types[path.extname(relative)] ?? "";
      if (!file || !type) return new Response(null, { status: 404 });
      body = new Uint8Array(await fs.readFile(file));
      // The viewer asks for library files with ?v=<library version>.
      if (new URL(request.url).searchParams.has("v")) cache = "private, max-age=31536000, immutable";
    }
    const headers = new Headers({ "Content-Type": type, "Content-Length": String(body.length), "Cache-Control": cache, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox", "Referrer-Policy": "no-referrer", "Vary": "Origin" });
    const origin = request.headers.get("origin");
    if (origin === exactOrigin) headers.set("Access-Control-Allow-Origin", origin);
    return new Response(request.method === "HEAD" ? null : new Uint8Array(body), { headers });
  } catch (error) {
    console.error(`Catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
    void recordFailure("catalog request", error);
    return new Response(null, { status: 404 });
  }
}
