import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveBranch, buildProjectArtifact, compareCheckpoints, createBranch, discardBranchChanges, exportCheckpoint, importCheckpoint, listProjects, makePrimaryBranch, projectBranches, projectRounds, registerProject, saveAttachment, saveRound } from "../src/index.ts";

const generator = (wallEnd: number, name: string) => `import {writeFileSync} from 'node:fs';writeFileSync(process.env.ARCH_ARTIFACT_OUTPUT+'/plan.json',JSON.stringify({version:1,name:'${name}',walls:[{id:'wall',a:[0,0],b:[${wallEnd},0]}],cameras:[{id:'entry',position:[1,1],height:2,lookAt:[2,2]}]}));`;

test("branches fork from checkpoints, build independently, carry rounds and switch the primary line", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-branches-")));
  const prior = process.env.ARCH_HOME;
  try {
    process.env.ARCH_HOME = path.join(temp, "store");
    const directory = path.join(temp, "project");
    await fs.mkdir(path.join(directory, "source"), { recursive: true });
    await fs.writeFile(path.join(directory, "source/generate.ts"), generator(4, "Test"));
    await fs.writeFile(path.join(directory, "arch.project.json"), JSON.stringify({ schemaVersion: 2, id: "test-house", name: "Test", client: { id: "internal", name: "Internal" }, description: "", entry: "source/generate.ts", runtime: { name: "arch-viewer", version: "0.1.0", threeVersion: "0.186.1" }, views: [], assumptions: [], references: [], artifacts: [] }));
    await fs.writeFile(path.join(directory, "arch.context.json"), JSON.stringify({ goal: "Test", driver: "Test", decisions: [], unresolved: [], nextAction: "Test", instructionVersion: "1" }));
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: { three: "0.186.1" } }));
    await fs.writeFile(path.join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { three: "0.186.1" } }, "node_modules/three": { version: "0.186.1", resolved: "https://registry.npmjs.org/three/-/three-0.186.1.tgz", integrity: "sha512-test" } } }));
    await registerProject(directory);
    const base = await buildProjectArtifact("test-house", { authorizeSourceExecution: true });

    const implicit = await projectBranches("test-house");
    expect(implicit.primary).toBe("main");
    expect(implicit.branches).toEqual([expect.objectContaining({ name: "main", directory, headId: base.checkpoint.id })]);

    const branch = await createBranch("test-house", { name: "longer-wall", from: base.checkpoint.id });
    expect(branch.directory).toBe(path.join(temp, "store/projects/test-house/branches/longer-wall"));
    expect(branch.headId).toBe(base.checkpoint.id);
    await expect(createBranch("test-house", { name: "longer-wall", from: base.checkpoint.id })).rejects.toThrow("already exists");
    await expect(createBranch("test-house", { name: "../escape", from: base.checkpoint.id })).rejects.toThrow();

    await fs.writeFile(path.join(branch.directory, "source/generate.ts"), generator(5, "Test"));
    // Agent sandboxes leave local state in the folder. It never blocks or enters a checkpoint.
    await fs.mkdir(path.join(branch.directory, ".claude"));
    await fs.writeFile(path.join(branch.directory, ".claude/.cc-writes"), "");
    const variant = await buildProjectArtifact("test-house", { authorizeSourceExecution: true, branch: "longer-wall" });
    expect(variant.checkpoint.parentId).toBe(base.checkpoint.id);
    expect(variant.checkpoint.files.some(file => file.path.startsWith(".claude"))).toBe(false);
    expect((await listProjects())[0]!.checkpointId).toBe(base.checkpoint.id);
    expect((await buildProjectArtifact("test-house", { authorizeSourceExecution: true })).checkpoint.id).toBe(base.checkpoint.id);

    const comparison = await compareCheckpoints(base.checkpoint.id, variant.checkpoint.id);
    expect(comparison.files).toEqual(expect.arrayContaining([{ path: "source/generate.ts", change: "modified" }, { path: "outputs/artifact/plan.json", change: "modified" }]));
    expect(comparison.plan?.walls).toEqual({ added: [], removed: [], modified: ["wall"] });
    expect(comparison.plan?.cameras).toEqual({ added: [], removed: [], modified: [] });
    expect(comparison.plan?.materials).toEqual({ added: [], removed: [], modified: [] });

    const attachment = await saveAttachment(new TextEncoder().encode("synthetic markup"));
    const round = { schemaVersion: 1 as const, id: randomUUID(), projectId: "test-house", branch: "longer-wall", kind: "request" as const, checkpointId: variant.checkpoint.id, parentCheckpointId: base.checkpoint.id, request: "Extend the wall by a metre", attachments: [{ name: "markup.png", sha256: attachment.sha256, size: attachment.size, mimeType: "image/png" }], provider: "claude" as const, model: "claude-opus-5-5", summary: "Extended the wall.", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    await saveRound(round);
    expect(await projectRounds("test-house")).toEqual([round]);
    const bundle = path.join(temp, "bundle");
    await exportCheckpoint(variant.checkpoint.id, bundle);
    process.env.ARCH_HOME = path.join(temp, "imported");
    await importCheckpoint(bundle);
    expect(await projectRounds("test-house")).toEqual([round]);
    expect(await fs.readFile(path.join(temp, "imported/blobs/sha256", attachment.sha256), "utf8")).toBe("synthetic markup");
    process.env.ARCH_HOME = path.join(temp, "store");

    await fs.mkdir(path.join(branch.directory, "node_modules"));
    await fs.writeFile(path.join(branch.directory, "source/generate.ts"), "broken");
    await discardBranchChanges("test-house", "longer-wall");
    expect(await fs.readFile(path.join(branch.directory, "source/generate.ts"), "utf8")).toBe(generator(5, "Test"));
    expect((await fs.stat(path.join(branch.directory, "node_modules"))).isDirectory()).toBe(true);

    await expect(archiveBranch("test-house", "main", true)).rejects.toThrow("primary");
    const switched = await makePrimaryBranch("test-house", "longer-wall");
    expect(switched.primary).toBe("longer-wall");
    expect(switched.branches.find(line => line.name === "main")).toEqual(expect.objectContaining({ directory, headId: base.checkpoint.id }));
    expect((await listProjects())[0]).toEqual(expect.objectContaining({ directory: branch.directory, checkpointId: variant.checkpoint.id }));
    expect((await archiveBranch("test-house", "main", true)).branches.find(line => line.name === "main")?.archived).toBe(true);
    await expect(makePrimaryBranch("test-house", "main")).rejects.toThrow("archived");
  } finally {
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
