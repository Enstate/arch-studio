import { z } from "zod";
import type { Plan } from "@arch/viewer/plan/schema";
import { validatePlan } from "@arch/viewer/plan/validate";
import {
  artifactManifestSchema,
  checkpointManifestSchema,
  type ArtifactManifest,
  type CheckpointManifest,
} from "./index.ts";

export const bundleLimits = Object.freeze({
  checkpointJsonBytes: 2 * 1024 * 1024,
  files: 4000,
  blobs: 4000,
  singleBlobBytes: 256 * 1024 * 1024,
  totalBlobBytes: 2 * 1024 * 1024 * 1024,
});
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Matches the established local checkpoint encoding, including key ordering. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Canonical JSON requires JSON values");
  return encoded;
}

export async function sha256(value: Uint8Array | string): Promise<string> {
  // WebCrypto accepts ArrayBuffer-backed views, not SharedArrayBuffer. Keep the
  // existing byte range without copying a potentially 256 MiB blob.
  const encoded = typeof value === "string" ? encoder.encode(value) : value;
  const buffer = encoded.buffer;
  if (!(buffer instanceof ArrayBuffer)) throw new Error("SHA-256 requires an ArrayBuffer");
  const bytes = new Uint8Array(buffer, encoded.byteOffset, encoded.byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkpointIdOf(checkpoint: Omit<CheckpointManifest, "id"> | CheckpointManifest): Promise<string> {
  const { id: _id, ...content } = checkpoint as CheckpointManifest;
  return sha256(canonicalJson(content));
}

const allowedRoots = new Set(["index.html", "AGENTS.md", "CLAUDE.md", "BUILDERS.md", "src", "source", "assets", "reference", "arch.project.json", "arch.context.json", "package.json", "package-lock.json", "bun.lock", "outputs"]);
const privateName = /(^\.|(?:^|[._-])(?:secrets?|credentials?|tokens?|private[-_]?key)(?:[._-]|$)|\.(?:pem|key|p12|pfx)$)/i;
function requireProjectPath(path: string): void {
  const parts = path.split("/");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted checkpoint paths.
  if (path.length > 1024 || /[\\%?#:\u0000-\u001f\u007f]/.test(path) || path.normalize("NFC") !== path || parts.some(part => !part || part === "." || part === ".." || privateName.test(part)) || !allowedRoots.has(parts[0]!)) throw new Error("Invalid checkpoint path");
}

function jsonBytes(bytes: Uint8Array, maximum = bundleLimits.checkpointJsonBytes): unknown {
  if (bytes.byteLength > maximum) throw new Error("JSON exceeds bundle limit");
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

/** Verifies the manifest's identity and bounds. Blob bytes are verified separately. */
export async function verifyCheckpointManifest(input: Uint8Array | unknown): Promise<CheckpointManifest> {
  const raw = input instanceof Uint8Array ? jsonBytes(input) : input;
  if (encoder.encode(canonicalJson(raw)).byteLength > bundleLimits.checkpointJsonBytes) throw new Error("Checkpoint JSON exceeds bundle limit");
  const checkpoint = checkpointManifestSchema.parse(raw);
  if (checkpoint.projectId !== checkpoint.project.id) throw new Error("Checkpoint project mismatch");
  if (checkpoint.files.length > bundleLimits.files) throw new Error("Too many checkpoint files");
  const paths = new Set<string>();
  const blobs = new Map<string, number>();
  for (const file of checkpoint.files) {
    requireProjectPath(file.path);
    if (paths.has(file.path)) throw new Error("Duplicate checkpoint path");
    paths.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size > bundleLimits.singleBlobBytes) throw new Error("Blob exceeds bundle limit");
    const previous = blobs.get(file.sha256);
    if (previous !== undefined && previous !== file.size) throw new Error("Conflicting blob sizes");
    blobs.set(file.sha256, file.size);
  }
  if (blobs.size > bundleLimits.blobs || [...blobs.values()].reduce((sum, size) => sum + size, 0) > bundleLimits.totalBlobBytes) throw new Error("Bundle exceeds byte limit");
  if (await checkpointIdOf(checkpoint) !== checkpoint.id) throw new Error("Checkpoint hash mismatch");
  return checkpoint;
}

const dataTypes: Record<string, string> = {
  json: "application/json", glb: "model/gltf-binary", gltf: "model/gltf+json", bin: "application/octet-stream",
  webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", hdr: "image/vnd.radiance", mp4: "video/mp4", webm: "video/webm",
};
export type ServingFile = ArtifactManifest["files"][number] & { contentType: string };
export type BlobReader = (sha256: string) => Promise<Uint8Array>;
export type VerifiedArtifact = { artifact: ArtifactManifest; artifactHash: string; sourceHash: string; servingFiles: ServingFile[] };

/** Metadata-only without readBlob. Supply readBlob before registering or serving an upload. */
export async function verifyArtifactManifest(checkpoint: CheckpointManifest, artifactBytes: Uint8Array, runtimeHash: string, readBlob?: BlobReader, options?: { verifiedBlobs?: boolean; maximumReadBytes?: number; totalReadBytes?: number }): Promise<VerifiedArtifact> {
  await verifyCheckpointManifest(checkpoint);
  if (checkpoint.project.schemaVersion !== 2) throw new Error("Hosted artifacts require a viewer project");
  const checkpointFiles = new Map(checkpoint.files.map(file => [file.path, file]));
  const manifestFile = checkpointFiles.get("outputs/artifact.json");
  if (!manifestFile || manifestFile.size !== artifactBytes.byteLength || await sha256(artifactBytes) !== manifestFile.sha256) throw new Error("Artifact manifest blob mismatch");
  const artifact = artifactManifestSchema.parse(jsonBytes(artifactBytes));
  if (!/^[a-f0-9]{64}$/.test(runtimeHash) || artifact.runtimeHash !== runtimeHash) throw new Error("Artifact runtime hash mismatch");
  if (artifact.projectId !== checkpoint.projectId || canonicalJson(artifact.runtime) !== canonicalJson(checkpoint.project.runtime)) throw new Error("Artifact project/runtime mismatch");
  const paths = new Set<string>();
  for (const file of [...artifact.sources, ...artifact.files]) {
    requireProjectPath(file.path);
    if (paths.has(file.path)) throw new Error("Duplicate artifact path");
    paths.add(file.path);
    const match = checkpointFiles.get(file.path);
    if (!match || match.sha256 !== file.sha256 || match.size !== file.size) throw new Error("Artifact checkpoint integrity failure");
  }
  if (artifact.sources.some(file => !file.path.startsWith("source/") && !file.path.startsWith("assets/"))) throw new Error("Invalid artifact source boundary");
  const servingFiles = artifact.files.map(file => {
    if (!file.path.startsWith("outputs/artifact/")) throw new Error("Invalid artifact output boundary");
    const extension = file.path.split(".").pop()!.toLowerCase();
    const contentType = dataTypes[extension];
    if (!contentType) throw new Error("Artifact contains executable or unsupported data");
    return { ...file, contentType };
  });
  if (artifact.plan !== "outputs/artifact/plan.json" || !artifact.files.some(file => file.path === artifact.plan)) throw new Error("Artifact plan missing");
  if (!artifact.files.some(file => file.path === "outputs/artifact/library/index.json")) throw new Error("Artifact library index missing");
  const outputPaths = new Set<string>();
  for (const output of artifact.outputs) {
    if (outputPaths.has(output.path)) throw new Error("Duplicate artifact output");
    outputPaths.add(output.path);
    const file = servingFiles.find(item => item.path === output.path);
    if (!file || (output.kind === "still" ? !file.contentType.startsWith("image/") || file.contentType === "image/vnd.radiance" : !file.contentType.startsWith("video/"))) throw new Error("Invalid artifact output");
  }
  if (readBlob) {
    // Read serially. Never retain the entire portable bundle in memory.
    // Only a server with durable checksum receipts may skip this pass. Semantic
    // validation below still authenticates every structured file it reads.
    for (const file of options?.verifiedBlobs ? [] : new Map(checkpoint.files.map(file => [file.sha256, file])).values()) {
      const bytes = await readBlob(file.sha256);
      if (bytes.byteLength !== file.size || await sha256(bytes) !== file.sha256) throw new Error("Checkpoint blob hash mismatch");
    }
    let readBytes = 0;
    const readPath = async (path: string) => {
      const file = checkpointFiles.get(path);
      if (!file) throw new Error("Required checkpoint file missing");
      readBytes += file.size;
      if (file.size > (options?.maximumReadBytes ?? bundleLimits.singleBlobBytes) || readBytes > (options?.totalReadBytes ?? bundleLimits.totalBlobBytes)) throw new Error("Structured artifact data exceeds verification limit");
      const bytes = await readBlob(file.sha256);
      if (bytes.byteLength !== file.size || await sha256(bytes) !== file.sha256) throw new Error("Checkpoint blob hash mismatch");
      return bytes;
    };
    if (canonicalJson(jsonBytes(await readPath("arch.project.json"))) !== canonicalJson(checkpoint.project) || canonicalJson(jsonBytes(await readPath("arch.context.json"))) !== canonicalJson(checkpoint.brief)) throw new Error("Checkpoint project/context bytes mismatch");
    await verifyArtifactPlan(artifact, readPath);
  }
  return { artifact, artifactHash: await sha256(canonicalJson(artifact)), sourceHash: await sha256(canonicalJson(artifact.sources)), servingFiles };
}

const pair = z.tuple([z.number(), z.number()]);
const named = { id: z.string().min(1) };
const material = z.object({ color: z.string(), texture: z.string().optional(), pbr: z.string().optional() }).passthrough();
// The geometry validator assumes these shapes. Match the local authoring boundary.
const planShape = z.object({
  version: z.literal(1), name: z.string(),
  defaults: z.object({ wallHeight: z.number().positive().optional(), exteriorThickness: z.number().positive().optional(), interiorThickness: z.number().positive().optional(), doorHeight: z.number().positive().optional(), windowSill: z.number().nonnegative().optional(), windowHeight: z.number().positive().optional(), exteriorFinish: z.string().optional(), interiorFinish: z.string().optional(), floor: z.string().optional(), ceiling: z.string().optional() }).optional(),
  walls: z.array(z.object({ ...named, a: pair, b: pair, height: z.number().optional(), thickness: z.number().optional() }).passthrough()).max(4000),
  openings: z.array(z.object({ ...named, wall: z.string(), type: z.enum(["door", "double-door", "sliding-door", "window", "opening", "garage-door"]), offset: z.number(), width: z.number(), height: z.number().optional(), sill: z.number().optional() }).passthrough()).max(4000).optional(),
  rooms: z.array(z.object({ ...named, name: z.string(), polygon: z.array(pair).max(4000), areaLabel: z.number().optional() }).passthrough()).max(4000).optional(),
  furniture: z.array(z.object({ ...named, type: z.string(), position: pair, size: z.tuple([z.number(), z.number(), z.number()]).optional(), model: z.string().optional() }).passthrough()).max(4000).optional(),
  cameras: z.array(z.object({ ...named, position: pair, lookAt: pair, height: z.number().optional(), lookAtHeight: z.number().optional(), fov: z.number().optional(), photo: z.string().optional() }).passthrough()).max(100).optional(),
  materials: z.record(z.string(), material).optional(), environment: z.string().optional(),
  source: z.object({ image: z.string(), pxPerMeter: z.number(), overall: pair.optional() }).passthrough().optional(),
}).passthrough();

async function verifyArtifactPlan(artifact: ArtifactManifest, readPath: (path: string) => Promise<Uint8Array>): Promise<void> {
  const plan = planShape.parse(jsonBytes(await readPath(artifact.plan))) as unknown as Plan;
  if (validatePlan(plan).some(issue => issue.level === "error")) throw new Error("Invalid generated plan");
  const paths = new Set(artifact.files.map(file => file.path));
  const local = (reference: string, library = false) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted asset references.
    if (typeof reference !== "string" || /[\\?#%:\u0000-\u001f\u007f]/.test(reference)) throw new Error("Asset reference must be a bundled relative path");
    const relative = reference.startsWith("@lib/") ? `library/${reference.slice(5)}` : library ? `library/${reference}` : reference.replace(/^\.\//, "");
    if (relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..") || !paths.has(`outputs/artifact/${relative}`)) throw new Error("Asset is not bundled");
  };
  if (plan.source?.image) local(plan.source.image);
  for (const camera of plan.cameras ?? []) if (camera.photo) local(camera.photo);
  for (const furniture of plan.furniture ?? []) if (furniture.model) local(furniture.model);
  for (const item of Object.values(plan.materials ?? {})) if (item.texture) local(item.texture);
  const pbr = Object.values(plan.materials ?? {}).flatMap(item => item.pbr ? [item.pbr] : []);
  const libraryPath = "outputs/artifact/library/index.json";
  if (pbr.length || plan.environment || (plan.furniture ?? []).some(item => item.model?.startsWith("@lib/"))) {
    if (!paths.has(libraryPath)) throw new Error("Plan requires a bundled asset library");
  }
  if (paths.has(libraryPath)) {
    const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
    const index = z.object({ version: z.number().int().positive(), textures: z.record(id, z.object({ res: z.array(z.number().int().positive()).min(1), maps: z.array(id).min(1) })), models: z.record(id, z.unknown()), hdris: z.record(id, z.unknown()) }).parse(jsonBytes(await readPath(libraryPath)));
    for (const name of pbr) {
      id.parse(name);
      const texture = index.textures[name];
      if (!texture) throw new Error("Unknown library texture");
      for (const resolution of texture.res) for (const map of texture.maps) local(`textures/${name}/${resolution}/${map}.webp`, true);
    }
    const environment = plan.environment ?? "suburban_garden";
    if (plan.environment || index.hdris[environment]) {
      id.parse(environment);
      if (!index.hdris[environment]) throw new Error("Unknown library environment");
      local(`hdri/${environment}.hdr`, true);
      local(`hdri/${environment}-env.hdr`, true);
    }
  }
  for (const file of artifact.files.filter(item => /\.(glb|gltf)$/i.test(item.path))) {
    const bytes = await readPath(file.path);
    let raw: unknown;
    if (/\.glb$/i.test(file.path)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("Invalid GLB header");
      const length = view.getUint32(12, true);
      if (length > bytes.byteLength - 20) throw new Error("Invalid GLB JSON chunk");
      raw = jsonBytes(bytes.subarray(20, 20 + length));
    } else raw = jsonBytes(bytes);
    const gltf = z.object({ buffers: z.array(z.object({ uri: z.string().optional() }).passthrough()).optional(), images: z.array(z.object({ uri: z.string().optional() }).passthrough()).optional() }).passthrough().parse(raw);
    for (const resource of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) if (resource.uri) {
      if (resource.uri.startsWith("data:")) continue;
      const base = file.path.slice("outputs/artifact/".length).split("/").slice(0, -1).join("/");
      local(base ? `${base}/${resource.uri}` : resource.uri);
    }
  }
}
