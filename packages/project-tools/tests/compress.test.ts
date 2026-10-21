import { expect, test } from "bun:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compressArtifactModels } from "../src/compress.ts";

/** A model as a generator writes it: a dense uncompressed grid with duplicated corner vertices. */
async function generatedModel() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const n = 60, positions: number[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) positions.push((i + a) / n, Math.sin(i + a), (j + b) / n);
  const position = doc.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", position).setMaterial(doc.createMaterial("paint")));
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

test("generated models come out meshopt-compressed and smaller, and compressed ones are left alone", async () => {
  const artifact = await mkdtemp(path.join(tmpdir(), "arch-compress-test-"));
  try {
    await mkdir(path.join(artifact, "models"), { recursive: true });
    const original = await generatedModel();
    await writeFile(path.join(artifact, "models/table.glb"), original);
    const first = await compressArtifactModels(artifact);
    expect(first.files).toBe(1);
    const compressed = await readFile(path.join(artifact, "models/table.glb"));
    expect(compressed.length).toBeLessThan(original.byteLength / 2);
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
    const doc = await io.readBinary(new Uint8Array(compressed));
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain("EXT_meshopt_compression");
    // Welded, with the same triangles drawn.
    const primitive = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    expect(primitive.getIndices()!.getCount()).toBe(60 * 60 * 6);
    const before = (await stat(path.join(artifact, "models/table.glb"))).mtimeMs;
    expect((await compressArtifactModels(artifact)).files).toBe(0);
    expect((await stat(path.join(artifact, "models/table.glb"))).mtimeMs).toBe(before);
  } finally {
    await rm(artifact, { recursive: true, force: true });
  }
});
