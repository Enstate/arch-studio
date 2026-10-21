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
