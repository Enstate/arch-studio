import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { addReviewNote, buildProjectArtifact, createBranch, exportProjectPackage, hasUnsavedChanges, importProjectPackage, inspectProject, inspectProjectPackage, listProjects, projectBranches, projectRounds, registerProject, saveAttachment, saveBranchCheckpoint, saveRound, type ProjectPackageMerge } from "../src/index.ts";

const generator = (wallEnd: number) => `import {writeFileSync} from 'node:fs';writeFileSync(process.env.ARCH_ARTIFACT_OUTPUT+'/plan.json',JSON.stringify({version:1,name:'Test',walls:[{id:'wall',a:[0,0],b:[${wallEnd},0]}],cameras:[{id:'entry',position:[1,1],height:2,lookAt:[2,2]}]}));`;

async function writeProject(directory: string) {
  await fs.mkdir(path.join(directory, "source"), { recursive: true });
  await fs.writeFile(path.join(directory, "source/generate.ts"), generator(4));
  await fs.writeFile(path.join(directory, "arch.project.json"), JSON.stringify({ schemaVersion: 2, id: "test-house", name: "Test", client: { id: "internal", name: "Internal" }, description: "", entry: "source/generate.ts", runtime: { name: "arch-viewer", version: "0.1.0", threeVersion: "0.186.1" }, views: [], assumptions: [], references: [], artifacts: [] }));
  await fs.writeFile(path.join(directory, "arch.context.json"), JSON.stringify({ goal: "Test", driver: "Test", decisions: [], unresolved: [], nextAction: "Test", instructionVersion: "1" }));
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: { three: "0.186.1" } }));
  await fs.writeFile(path.join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { three: "0.186.1" } }, "node_modules/three": { version: "0.186.1", resolved: "https://registry.npmjs.org/three/-/three-0.186.1.tgz", integrity: "sha512-test" } } }));
  await registerProject(directory);
}

async function rejection(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error as Error & { cause?: Error }; }
  throw new Error("Expected the import to fail");
}

test("a project package carries every version, branch, note and round into a fresh store, and rejects bad packages", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-package-")));
  const prior = process.env.ARCH_HOME;
  try {
    process.env.ARCH_HOME = path.join(temp, "store");
    await writeProject(path.join(temp, "project"));
    const base = await buildProjectArtifact("test-house", { authorizeSourceExecution: true });
    const branch = await createBranch("test-house", { name: "longer-wall", from: base.checkpoint.id });
    await fs.writeFile(path.join(branch.directory, "source/generate.ts"), generator(5));
    const variant = await buildProjectArtifact("test-house", { authorizeSourceExecution: true, branch: "longer-wall" });
    const note = await addReviewNote("test-house", { checkpointId: base.checkpoint.id, author: "Reviewer", body: "Check the wall." });
    // PNG bytes are stored, not deflated. Both entry kinds must survive.
    const image = await saveAttachment(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("synthetic markup")]));
    const round = { schemaVersion: 1 as const, id: randomUUID(), projectId: "test-house", branch: "longer-wall", kind: "request" as const, checkpointId: variant.checkpoint.id, parentCheckpointId: base.checkpoint.id, request: "Extend the wall", attachments: [{ name: "markup.png", sha256: image.sha256, size: image.size, mimeType: "image/png" }], provider: "claude" as const, model: "claude-opus-5-5", summary: "Extended the wall.", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    await saveRound(round);
    const viewed = await saveAttachment(new TextEncoder().encode("an image the agent viewed"));
    const before = await inspectProject("test-house");

    const file = path.join(temp, "exports", "test.archproject");
    const exported = await exportProjectPackage("test-house", file, { name: "Test house", studio: { threads: ["synthetic"] }, blobs: [viewed.sha256] });
    expect(exported.bytes).toBe((await fs.stat(file)).size);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const packaged = unzipSync(new Uint8Array(await fs.readFile(file)));
    expect(Object.keys(packaged)[0]).toBe("arch-project.json");
    expect(new TextDecoder().decode(packaged["arch-project.json"])).not.toContain(temp);

    process.env.ARCH_HOME = path.join(temp, "imported");
    let published: unknown = null;
    const imported = await importProjectPackage(file, { accept: (value) => value, publish: (value) => { published = value; } });
    expect(published).toEqual({ threads: ["synthetic"] });
    expect(imported.contents.name).toBe("Test house");
    const folders = path.join(temp, "imported/projects/test-house/branches");
    const lines = await projectBranches("test-house");
    expect(lines.primary).toBe("main");
    expect(lines.branches).toEqual([
      expect.objectContaining({ name: "main", directory: path.join(folders, "main"), headId: base.checkpoint.id, archived: false }),
      expect.objectContaining({ name: "longer-wall", directory: path.join(folders, "longer-wall"), headId: variant.checkpoint.id, forkedFrom: base.checkpoint.id }),
    ]);
    expect(await listProjects()).toEqual([expect.objectContaining({ directory: path.join(folders, "main"), checkpointId: base.checkpoint.id })]);
    const after = await inspectProject("test-house");
    expect(after.checkpoints).toEqual(before.checkpoints);
    expect(after.notes).toEqual([note]);
    expect(await projectRounds("test-house")).toEqual([round]);
    expect(await fs.readFile(path.join(folders, "longer-wall/source/generate.ts"), "utf8")).toBe(generator(5));
    expect(await fs.readFile(path.join(folders, "main/AGENT_BRIEF.md"), "utf8")).toContain("Check the wall.");
    expect(await fs.readFile(path.join(temp, "imported/blobs/sha256", viewed.sha256), "utf8")).toBe("an image the agent viewed");
    expect((await buildProjectArtifact("test-house", { authorizeSourceExecution: true, branch: "longer-wall" })).checkpoint.id).toBe(variant.checkpoint.id);

    // Opening the same file again finds nothing new and writes nothing.
    const again = await importProjectPackage(file);
    expect(again.outcome).toBe("unchanged");
    expect(again.merge?.variants.map((variant) => variant.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(await projectBranches("test-house")).toEqual(lines);

    const fresh = async (name: string, entries: Record<string, Uint8Array>) => {
      process.env.ARCH_HOME = path.join(temp, name);
      const target = path.join(temp, `${name}.archproject`);
      await fs.writeFile(target, zipSync(entries));
      const error = await rejection(importProjectPackage(target));
      expect(await listProjects()).toEqual([]);
      expect(await fs.readdir(path.join(temp, name, "projects")).catch(() => [])).toEqual([]);
      return error;
    };
    const generatorBlob = variant.checkpoint.files.find((entry) => entry.path === "source/generate.ts")!.sha256;
    const tampered = { ...packaged, [`blobs/${generatorBlob}`]: new TextEncoder().encode(generator(9).padEnd(generator(5).length)) };
    const integrity = await fresh("tampered", tampered);
    expect(integrity.message).toBe("ARCH_PACKAGE_INVALID");
    expect(integrity.cause?.message).toContain("integrity");

    const traversal = await fresh("traversal", { ...packaged, "../escape": new TextEncoder().encode("x") });
    expect(traversal.message).toBe("ARCH_PACKAGE_INVALID");
    expect(traversal.cause?.message).toContain("Unsafe archive entry name");
    expect(await fs.access(path.join(temp, "escape")).then(() => true, () => false)).toBe(false);

    const unknown = await fresh("unknown", { ...packaged, "notes.txt": new TextEncoder().encode("x") });
    expect(unknown.cause?.message).toContain("Unexpected package entry");
  } finally {
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("opening a project that is already here only adds: it moves clean branches forward and keeps the rest separately", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-merge-")));
  const prior = process.env.ARCH_HOME;
  const origin = path.join(temp, "origin");
  const copy = path.join(temp, "copy");
  const edit = async (directory: string, wallEnd: number) => fs.writeFile(path.join(directory, "source/generate.ts"), generator(wallEnd));
  try {
    process.env.ARCH_HOME = origin;
    await writeProject(path.join(temp, "project"));
    expect((await rejection(exportProjectPackage("test-house", path.join(temp, "empty.archproject")))).message).toBe("ARCH_EXPORT_NEEDS_VERSION");
    const base = (await buildProjectArtifact("test-house", { authorizeSourceExecution: true })).checkpoint;
    const wall = await createBranch("test-house", { name: "longer-wall", from: base.id });
    await edit(wall.directory, 5);
    const variant = await saveBranchCheckpoint("test-house", "longer-wall");
    const porch = await createBranch("test-house", { name: "porch", from: base.id });
    await createBranch("test-house", { name: "attic", from: base.id });
    const first = await addReviewNote("test-house", { checkpointId: base.id, author: "Reviewer", body: "Check the wall." });
    const firstFile = path.join(temp, "first.archproject");
    await exportProjectPackage("test-house", firstFile);

    process.env.ARCH_HOME = copy;
    expect((await importProjectPackage(firstFile)).outcome).toBe("added");
    const local = Object.fromEntries((await projectBranches("test-house")).branches.map((line) => [line.name, line]));
    // Diverge longer-wall, leave porch with unsaved work, and move attic ahead of the sender.
    await edit(local["longer-wall"]!.directory, 7);
    const diverged = await saveBranchCheckpoint("test-house", "longer-wall");
    await edit(local.porch!.directory, 8);
    await edit(local.attic!.directory, 9);
    const ahead = await saveBranchCheckpoint("test-house", "attic");
    await fs.mkdir(path.join(local.main!.directory, ".git"));
    await fs.writeFile(path.join(local.main!.directory, ".git/HEAD"), "ref: refs/heads/main\n");

    process.env.ARCH_HOME = origin;
    await edit(path.join(temp, "project"), 6);
    const forward = (await buildProjectArtifact("test-house", { authorizeSourceExecution: true })).checkpoint;
    await edit(wall.directory, 10);
    const wallAhead = await saveBranchCheckpoint("test-house", "longer-wall");
    await edit(porch.directory, 11);
    const porchAhead = await saveBranchCheckpoint("test-house", "porch");
    const side = await createBranch("test-house", { name: "side", from: base.id });
    const second = await addReviewNote("test-house", { checkpointId: forward.id, author: "Reviewer", body: "Looks right." });
    const round = { schemaVersion: 1 as const, id: randomUUID(), projectId: "test-house", branch: "longer-wall", kind: "request" as const, checkpointId: wallAhead.id, parentCheckpointId: variant.id, request: `Read ${path.join(wall.directory, "source/generate.ts")} and ${path.join(origin, "blobs")} from ${path.join(os.homedir(), "Desktop")}`, attachments: [], provider: "claude" as const, model: "claude-opus-5-5", summary: `Edited ${wall.directory}.`, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    await saveRound(round);
    const secondFile = path.join(temp, "second.archproject");
    await exportProjectPackage("test-house", secondFile);
    const header = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(await fs.readFile(secondFile)))["arch-project.json"])) as { rounds: { request: string; summary: string }[] };
    // Machine paths never travel: branch folders become relative, then the store and the home folder.
    expect(header.rounds[0]!.request).toBe("Read source/generate.ts and <store>/blobs from ~/Desktop");
    expect(header.rounds[0]!.summary).toBe("Edited ..");

    process.env.ARCH_HOME = copy;
    expect(await hasUnsavedChanges("test-house", "porch")).toBe(true);
    expect(await hasUnsavedChanges("test-house", "main")).toBe(false);
    const held: string[][] = [];
    let published: ProjectPackageMerge | null = null;
    const studio = {
      accept: (value: unknown) => value,
      added: () => 0,
      publish: (_value: unknown, merge: ProjectPackageMerge | null) => { published = merge; },
      hold: <R>(_projectId: string, branches: string[], work: (busy: ReadonlySet<string>) => Promise<R>) => { held.push(branches); return work(new Set()); },
    };
    const preview = await inspectProjectPackage(secondFile, studio);
    const expected = [
      { name: "main", outcome: "updated" },
      { name: "longer-wall", outcome: "kept-separately", as: "longer-wall-received" },
      { name: "porch", outcome: "kept-separately", as: "porch-received" },
      { name: "attic", outcome: "unchanged" },
      { name: "side", outcome: "added" },
    ];
    // Saved folders keep their last build output, so all three new versions have a model.
    expect(preview.merge).toEqual({ variants: expected, checkpoints: 3, builtCheckpoints: 3, notes: 1, rounds: 1, conversations: 0 });
    // A branch a round still works in is never replaced.
    const busy = await inspectProjectPackage(secondFile, { ...studio, hold: <R>(_projectId: string, _branches: string[], work: (busy: ReadonlySet<string>) => Promise<R>) => work(new Set(["main"])) });
    expect(busy.merge?.variants[0]).toEqual({ name: "main", outcome: "kept-separately", as: "main-received" });
    // Inspecting changes nothing.
    expect((await projectBranches("test-house")).branches.map((line) => line.name)).toEqual(["main", "longer-wall", "porch", "attic"]);

    const merged = await importProjectPackage(secondFile, studio);
    expect(merged.outcome).toBe("updated");
    expect(published).toEqual(preview.merge);
    expect(held.at(-1)).toEqual(["main", "longer-wall", "porch", "attic"]);
    const lines = await projectBranches("test-house");
    const after = Object.fromEntries(lines.branches.map((line) => [line.name, line]));
    expect(lines.primary).toBe("main");
    // A clean branch moves forward and keeps its version control folder.
    expect(after.main!.headId).toBe(forward.id);
    expect(await fs.readFile(path.join(after.main!.directory, "source/generate.ts"), "utf8")).toBe(generator(6));
    expect(await fs.readFile(path.join(after.main!.directory, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(await fs.readFile(path.join(after.main!.directory, "AGENT_BRIEF.md"), "utf8")).toContain("Looks right.");
    expect(await hasUnsavedChanges("test-house", "main")).toBe(false);
    expect((await listProjects())[0]!.checkpointId).toBe(forward.id);
    // A diverged branch stays, and the incoming line arrives beside it from the shared version.
    expect(after["longer-wall"]!.headId).toBe(diverged.id);
    expect(after["longer-wall-received"]).toEqual(expect.objectContaining({ headId: wallAhead.id, forkedFrom: variant.id, archived: false }));
    // Unsaved work stays in its folder.
    expect(after.porch!.headId).toBe(base.id);
    expect(await fs.readFile(path.join(after.porch!.directory, "source/generate.ts"), "utf8")).toBe(generator(8));
    expect(after["porch-received"]).toEqual(expect.objectContaining({ headId: porchAhead.id, forkedFrom: base.id }));
    // A branch that is ahead here is left alone, and a new one arrives under its own name.
    expect(after.attic!.headId).toBe(ahead.id);
    expect(after.side).toEqual(expect.objectContaining({ headId: side.headId, forkedFrom: base.id, createdAt: side.createdAt }));
    expect(await fs.readFile(path.join(after.side!.directory, "source/generate.ts"), "utf8")).toBe(generator(4));
    expect((await inspectProject("test-house")).notes).toEqual([first, second]);
    expect((await projectRounds("test-house")).map((saved) => saved.branch)).toEqual(["longer-wall-received"]);
    expect((await fs.readdir(path.join(copy, "projects/test-house/branches"))).filter((name) => name.startsWith("."))).toEqual([]);

    // Opening the same file again changes nothing.
    const catalogBefore = await fs.readFile(path.join(copy, "catalog.json"), "utf8");
    const again = await importProjectPackage(secondFile, studio);
    expect(again.outcome).toBe("unchanged");
    expect(await projectBranches("test-house")).toEqual(lines);
    expect(await fs.readFile(path.join(copy, "catalog.json"), "utf8")).toBe(catalogBefore);
  } finally {
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
