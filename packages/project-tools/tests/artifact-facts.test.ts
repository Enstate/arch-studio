import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectArtifact } from "../src/index.ts";
import { initializeProject } from "../src/intake.ts";

/** A GLB holding only its JSON chunk, which is all the build reads to find compression extensions. */
function glbDeclaring(extensions: string[]): Buffer {
  let json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: extensions, extensionsRequired: extensions }));
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}

test("confirmed facts set the artifact's latitude and north, and the build explains what it rejects", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-artifact-facts-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const directory = path.join(temporary, "source");
    await initializeProject({ directory, id: "sunny-plaza", name: "Sunny plaza", facts: { kind: "public-space", location: { label: "Synthetic plaza", latitude: -33.44, longitude: -70.65 }, north: 15 } });
    await fs.writeFile(path.join(directory, "assets/plan.json"), JSON.stringify({ version: 1, name: "Sunny plaza", walls: [{ id: "seat-wall", a: [0, 0], b: [6, 0], height: 0.45 }], north: 90 }));
    const built = await buildProjectArtifact("sunny-plaza", { authorizeSourceExecution: true });
    const bytes = await fs.readFile(path.join(directory, "outputs/artifact/plan.json"));
    const plan = JSON.parse(bytes.toString()) as { latitude?: number; north?: number };
    expect(plan.latitude).toBe(-33.44);
    expect(plan.north).toBe(15);
    // The manifest hashes the plan as written, facts included.
    const entry = built.artifact.files.find(file => file.path === built.artifact.plan)!;
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(built.checkpoint.files.find(file => file.path === built.artifact.plan)?.sha256).toBe(entry.sha256);

    await fs.mkdir(path.join(directory, "assets/models"), { recursive: true });
    await fs.writeFile(path.join(directory, "assets/models/terrain.glb"), glbDeclaring(["KHR_draco_mesh_compression"]));
    await fs.writeFile(path.join(directory, "assets/models/bench.gltf"), JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: ["KHR_texture_basisu"] }));
    const compressed = await buildProjectArtifact("sunny-plaza", { authorizeSourceExecution: true }).catch((error: Error) => error);
    expect(compressed).toBeInstanceOf(Error);
    expect((compressed as Error).message).toContain("models/terrain.glb uses Draco mesh compression (KHR_draco_mesh_compression)");
    expect((compressed as Error).message).toContain("models/bench.gltf uses Basis Universal (KTX2) textures (KHR_texture_basisu)");
    expect((compressed as Error).message).toContain("Export each one again without Draco or KTX2/Basis compression");
    await fs.rm(path.join(directory, "assets/models"), { recursive: true });

    const pkg = path.join(directory, "package.json");
    await fs.writeFile(pkg, JSON.stringify({ name: "sunny-plaza", private: true, type: "module", dependencies: { three: "0.186.1", "simplex-noise": "4.0.3" }, devDependencies: { typescript: "5.9.0" } }));
    const dependency = await buildProjectArtifact("sunny-plaza", { authorizeSourceExecution: true }).catch((error: Error) => error);
    expect((dependency as Error).message).toContain("package.json lists simplex-noise@4.0.3, typescript@5.9.0 (devDependencies).");
    expect((dependency as Error).message).toContain("The build accepts exactly one package: three 0.186.1");
    expect((dependency as Error).message).toContain("write that code yourself in source/");
    expect((dependency as Error).message).toContain('BUILDERS.md "Dependencies"');
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
