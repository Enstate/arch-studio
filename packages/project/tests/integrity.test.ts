import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ArtifactManifest, CheckpointManifest } from "../src/index.ts";
import { bundleLimits, canonicalJson, checkpointIdOf, sha256, verifyArtifactManifest, verifyCheckpointManifest } from "../src/integrity.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const runtimeHash = "a".repeat(64);
async function fixture(options: { plan?: unknown; extra?: Record<string, unknown>; mutateArtifact?: (artifact: ArtifactManifest) => void } = {}) {
  const project = { schemaVersion: 2 as const, id: "portable-test", name: "Portable test", client: { id: "test-client", name: "Test client" }, description: "Synthetic integrity fixture", entry: "source/generate.mjs", runtime: { name: "arch-viewer" as const, version: "0.1.0" as const, threeVersion: "0.186.1" as const }, views: [], assumptions: [], references: [], artifacts: [] };
  const brief = { goal: "Synthetic room", driver: "test", decisions: [], unresolved: [], nextAction: "Review", instructionVersion: "test-1" };
  const bytes = new Map<string, Uint8Array>();
  const contents = {
    "arch.project.json": encode(project), "arch.context.json": encode(brief),
    "source/generate.mjs": new TextEncoder().encode("// private generator"),
    "reference/brief.md": new TextEncoder().encode("Private customer instructions"),
    "outputs/artifact/plan.json": encode(options.plan ?? { version: 1, name: "Synthetic room", walls: [{ id: "wall", a: [0, 0], b: [5, 0] }] }),
    "outputs/artifact/library/index.json": encode({version: 1, textures: {}, models: {}, hdris: {}}),
    ...Object.fromEntries(Object.entries(options.extra ?? {}).map(([path, value]) => [path, encode(value)])),
  };
  const files = await Promise.all(Object.entries(contents).map(async ([path, value]) => {
    const digest = await sha256(value); bytes.set(digest, value);
    return { path, sha256: digest, size: value.byteLength };
  }));
  const artifact: ArtifactManifest = { schemaVersion: 1, projectId: project.id, runtime: project.runtime, runtimeHash,
    sources: files.filter(file => file.path.startsWith("source/")), plan: "outputs/artifact/plan.json", files: files.filter(file => file.path.startsWith("outputs/artifact/")), cameras: [], outputs: [] };
  options.mutateArtifact?.(artifact);
  const artifactBytes = encode(artifact);
  const manifestHash = await sha256(artifactBytes); bytes.set(manifestHash, artifactBytes);
  files.push({ path: "outputs/artifact.json", sha256: manifestHash, size: artifactBytes.byteLength });
  const content = { schemaVersion: 1 as const, projectId: project.id, parentId: null, createdAt: "2026-10-19T00:00:00.000Z", project, brief, files };
  const checkpoint: CheckpointManifest = { ...content, id: await checkpointIdOf(content) };
  return { checkpoint, artifactBytes, artifact, bytes, readBlob: async (digest: string) => {
    const value = bytes.get(digest); if (!value) throw new Error("Missing fixture blob"); return value;
  } };
}
async function reidentify(checkpoint: CheckpointManifest) { checkpoint.id = await checkpointIdOf(checkpoint); return checkpoint; }

describe("portable integrity boundary", () => {
  test("matches established local canonical hashes and omits checkpoint id", async () => {
    const value = { z: [3, { a: "é", b: true }], a: null };
    const expected = '{"a":null,"z":[3,{"a":"é","b":true}]}';
    expect(canonicalJson(value)).toBe(expected);
    expect(await sha256(expected)).toBe(createHash("sha256").update(expected).digest("hex"));
    const { checkpoint } = await fixture();
    expect(await checkpointIdOf({ ...checkpoint, id: "b".repeat(64) })).toBe(checkpoint.id);
    expect((await verifyCheckpointManifest(encode(checkpoint))).id).toBe(checkpoint.id);
  });
  test("verifies every byte and exposes only artifact data paths", async () => {
    const value = await fixture();
    const verified = await verifyArtifactManifest(value.checkpoint, value.artifactBytes, runtimeHash, value.readBlob);
    expect(verified.servingFiles).toEqual(value.artifact.files.map(file => ({ ...file, contentType: "application/json" })));
    expect(verified.artifactHash).toBe(await sha256(canonicalJson(value.artifact)));
    expect(verified.sourceHash).toBe(await sha256(canonicalJson(value.artifact.sources)));
    value.bytes.set(value.checkpoint.files.find(file => file.path === "reference/brief.md")!.sha256, encode("tampered private input"));
    await expect(verifyArtifactManifest(value.checkpoint, value.artifactBytes, runtimeHash, value.readBlob)).rejects.toThrow("blob hash mismatch");
  });
  test("refuses duplicate paths, noncanonical/private paths and conflicting deduplicated sizes", async () => {
    for (const path of ["source/../bad", "outputs/artifact/%2f.json", "outputs/artifact/.env", "source/private-key.txt", "outputs/artifact/a?x.json", "outputs/artifact/cafe\u0301.json"]) {
      const { checkpoint } = await fixture(); checkpoint.files[0]!.path = path;
      await expect(verifyCheckpointManifest(await reidentify(checkpoint))).rejects.toThrow();
    }
    const first = await fixture(); first.checkpoint.files.push({ ...first.checkpoint.files[0]! });
    await expect(verifyCheckpointManifest(await reidentify(first.checkpoint))).rejects.toThrow("Duplicate checkpoint path");
    const second = await fixture(); second.checkpoint.files.push({ ...second.checkpoint.files[0]!, path: "reference/second.json", size: 1 });
    await expect(verifyCheckpointManifest(await reidentify(second.checkpoint))).rejects.toThrow("Conflicting blob sizes");
  });
  test("refuses incorrect identities and all declared bundle limits", async () => {
    const value = await fixture(); value.checkpoint.id = "b".repeat(64);
    await expect(verifyCheckpointManifest(value.checkpoint)).rejects.toThrow("Checkpoint hash mismatch");
    const large = await fixture(); large.checkpoint.files[0]!.size = bundleLimits.singleBlobBytes + 1;
    await expect(verifyCheckpointManifest(await reidentify(large.checkpoint))).rejects.toThrow("Blob exceeds bundle limit");
    const many = await fixture(); many.checkpoint.files = Array.from({ length: bundleLimits.files + 1 }, (_, i) => ({ path: `reference/${i}.txt`, sha256: "a".repeat(64), size: 0 }));
    await expect(verifyCheckpointManifest(await reidentify(many.checkpoint))).rejects.toThrow("Too many checkpoint files");
    const total = await fixture(); total.checkpoint.files = Array.from({ length: 9 }, (_, i) => ({ path: `reference/${i}.txt`, sha256: i.toString(16).padStart(64, "0"), size: bundleLimits.singleBlobBytes }));
    await expect(verifyCheckpointManifest(await reidentify(total.checkpoint))).rejects.toThrow("Bundle exceeds byte limit");
    await expect(verifyCheckpointManifest(new Uint8Array(bundleLimits.checkpointJsonBytes + 1))).rejects.toThrow("JSON exceeds bundle limit");
  });
  test("refuses unsupported outputs, source exposure and different runtime", async () => {
    const script = await fixture({ extra: { "outputs/artifact/run.js": "execute" } });
    await expect(verifyArtifactManifest(script.checkpoint, script.artifactBytes, runtimeHash)).rejects.toThrow("executable or unsupported");
    const source = await fixture({ mutateArtifact: artifact => { artifact.files.push(artifact.sources[0]!); } });
    await expect(verifyArtifactManifest(source.checkpoint, source.artifactBytes, runtimeHash)).rejects.toThrow();
    const wrong = await fixture();
    await expect(verifyArtifactManifest(wrong.checkpoint, wrong.artifactBytes, "b".repeat(64))).rejects.toThrow("runtime hash mismatch");
    await expect(verifyArtifactManifest(wrong.checkpoint, encode({}), runtimeHash)).rejects.toThrow("manifest blob mismatch");
  });
  test("refuses remote or missing plan and glTF resources and malformed geometry", async () => {
    const base = { version: 1, name: "Synthetic", walls: [{ id: "wall", a: [0, 0], b: [5, 0] }] };
    for (const reference of ["https://example.com/model.glb", "../private.glb", "%2fprivate.glb", "missing.glb"]) {
      const value = await fixture({ plan: { ...base, furniture: [{ id: "box", type: "box", position: [1, 1], model: reference }] } });
      await expect(verifyArtifactManifest(value.checkpoint, value.artifactBytes, runtimeHash, value.readBlob)).rejects.toThrow();
    }
    const remote = await fixture({ extra: { "outputs/artifact/model.gltf": { buffers: [{ uri: "https://example.com/buffer.bin" }] } } });
    await expect(verifyArtifactManifest(remote.checkpoint, remote.artifactBytes, runtimeHash, remote.readBlob)).rejects.toThrow("bundled relative path");
    const bad = await fixture({ plan: { ...base, walls: [{ id: "wall", a: [0, 0], b: [0, 0] }] } });
    await expect(verifyArtifactManifest(bad.checkpoint, bad.artifactBytes, runtimeHash, bad.readBlob)).rejects.toThrow("Invalid generated plan");
  });
  test("refuses checkpoint context bytes that disagree with the signed brief", async () => {
    const value = await fixture(); value.checkpoint.brief.nextAction = "Changed only in manifest"; await reidentify(value.checkpoint);
    await expect(verifyArtifactManifest(value.checkpoint, value.artifactBytes, runtimeHash, value.readBlob)).rejects.toThrow("project/context bytes mismatch");
  });
});

test("reviewed sharpness runtime verifies an unchanged previous-runtime checkpoint", async () => {
  const oldRuntime = "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199";
  const sharpRuntime = "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd";
  const saved = await fixture({mutateArtifact: artifact => { artifact.runtimeHash = oldRuntime; }});
  const original = JSON.stringify(saved.checkpoint);
  const verified = await verifyArtifactManifest(saved.checkpoint, saved.artifactBytes, sharpRuntime, saved.readBlob);
  expect(verified.artifact.runtimeHash).toBe(oldRuntime);
  expect(JSON.stringify(saved.checkpoint)).toBe(original);
  await expect(verifyArtifactManifest(saved.checkpoint, saved.artifactBytes, "b".repeat(64), saved.readBlob)).rejects.toThrow("runtime hash mismatch");
  const newer = await fixture({mutateArtifact: artifact => { artifact.runtimeHash = sharpRuntime; }});
  await expect(verifyArtifactManifest(newer.checkpoint, newer.artifactBytes, oldRuntime, newer.readBlob)).rejects.toThrow("runtime hash mismatch");
});
