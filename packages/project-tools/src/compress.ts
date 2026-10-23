import { Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { promises as fs } from "node:fs";
import path from "node:path";

/** What compressing an artifact's models saved. */
export interface ModelCompression {
  files: number;
  before: number;
  after: number;
}

/** glTF extensions the build cannot decode, with what they compress. */
const unreadableExtensions: Record<string, string> = {
  KHR_draco_mesh_compression: "Draco mesh compression",
  KHR_texture_basisu: "Basis Universal (KTX2) textures",
};

/** The extensions a .glb or .gltf file declares, read from its JSON alone. */
function declaredExtensions(bytes: Buffer, binary: boolean): string[] {
  let json: unknown;
  try {
    if (binary) {
      if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(16) !== 0x4e4f534a) return [];
      json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
    } else json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  if (!json || typeof json !== "object") return [];
  const { extensionsUsed, extensionsRequired } = json as { extensionsUsed?: unknown; extensionsRequired?: unknown };
  return [...(Array.isArray(extensionsUsed) ? extensionsUsed : []), ...(Array.isArray(extensionsRequired) ? extensionsRequired : [])].filter((name): name is string => typeof name === "string");
}

/**
 * Rejects models in an artifact folder that use Draco or Basis compression, naming each file and
 * the fix. The build cannot read them, and it compresses plain models itself.
 */
export async function requireReadableModels(artifact: string): Promise<void> {
  const problems: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(glb|gltf)$/i.test(entry.name)) {
        const used = [...new Set(declaredExtensions(await fs.readFile(file), /\.glb$/i.test(entry.name)))].filter(name => name in unreadableExtensions);
        if (used.length) problems.push(`${path.relative(artifact, file).split(path.sep).join("/")} uses ${used.map(name => `${unreadableExtensions[name]} (${name})`).join(" and ")}`);
      }
    }
  };
  await walk(artifact);
  if (problems.length)
    throw new Error(`The build cannot read compressed models: ${problems.join("; ")}. Export each one again without Draco or KTX2/Basis compression, as a plain GLB with PNG, JPEG or WebP textures, and keep it uncompressed in assets/. The build compresses models with meshopt itself.`);
}

/**
 * Compresses the binary glTF models a generator wrote into an artifact folder: shared data merged,
 * unused data dropped, vertices welded and the geometry meshopt-compressed, which the viewer decodes.
 * Models already compressed, such as the shared library's, are left as they are, and a model is only
 * replaced when the result is smaller. Textures are untouched, so nothing changes how a model looks
 * beyond vertex precision the eye cannot see at room scale.
 */
export async function compressArtifactModels(artifact: string): Promise<ModelCompression> {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR)).registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  const models: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      // Links are never followed: the artifact's own files only.
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) models.push(file);
    }
  };
  await walk(artifact);
  const result: ModelCompression = { files: 0, before: 0, after: 0 };
  for (const file of models) {
    const bytes = await fs.readFile(file);
    const document = await io.readBinary(new Uint8Array(bytes));
    if (document.getRoot().listExtensionsUsed().some((extension) => extension.extensionName === "EXT_meshopt_compression")) continue;
    await document.transform(dedup(), prune(), weld(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
    const compressed = await io.writeBinary(document);
    if (compressed.byteLength >= bytes.length) continue;
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, compressed, { flag: "wx" });
    await fs.rename(temporary, file);
    result.files++;
    result.before += bytes.length;
    result.after += compressed.byteLength;
  }
  return result;
}
