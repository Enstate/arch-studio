import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectIntakeSchema, type ProjectIntakePlan } from "@arch/project";
import { buildProjectArtifact, exportCheckpoint, importCheckpoint, inspectArtifact, inspectSource, listProjects, readProjectIntake, readCheckpointIntake, referenceFile, registerProject, restoreCheckpoint, saveCheckpoint } from "../src/index.ts";
import { initializeProject } from "../src/intake.ts";

test("ordinary references initialize a portable unrendered source and reject unsafe intake", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-intake-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const inputsDirectory = path.join(temporary, "plans");
    await fs.mkdir(path.join(inputsDirectory, "upper floor"), { recursive: true });
    const reference = Buffer.from("%PDF-1.7\nSynthetic plan: room 4m x 3m, ceiling 2.6m.\n");
    await fs.writeFile(path.join(inputsDirectory, "upper floor/plan.pdf"), reference);
    await fs.writeFile(path.join(inputsDirectory, "brief.md"), "Warm oak and white walls.\n");
    await fs.writeFile(path.join(inputsDirectory, ".DS_Store"), "Finder metadata");
    const options = { inputsDirectory, directory: path.join(temporary, "source"), id: "new-house", name: "New house", client: { id: "test-client", name: "Test Client" } };
    const result = await initializeProject(options);
    const intake = await readProjectIntake(options.directory);
    expect(intake).toEqual({
      version: 1, brief: options.name, style: "", pieces: [],
      documents: result.project.manifest.references.map((reference, index) => ({
        id: `doc-${index + 1}`, path: reference.path, page: 1, label: reference.label, role: "unresolved",
      })),
    });
    const intakeBytes = await fs.readFile(path.join(options.directory, "source/intake.json"));
    expect(result.checkpoint.files.find(file => file.path === "source/intake.json")?.size).toBe(intakeBytes.length);
    expect(result.project).not.toHaveProperty("intake");
    expect(result.project.manifest).not.toHaveProperty("intake");
    expect(result.checkpoint.files.some(file => file.path.includes(".DS_Store"))).toBe(false);
    expect(result.project.manifest.references.every(reference => reference.kind === "other")).toBe(true);
    expect(result.project.stage).toBe("draft");
    expect(result.project.checkpointId).toBe(result.checkpoint.id);
    expect(result.checkpoint.parentId).toBeNull();
    expect(result.project.manifest.views).toEqual([]);
    expect(result.project.manifest.artifacts).toEqual([]);
    expect(result.project.manifest.assumptions.every(item => item.status === "unconfirmed")).toBe(true);
    expect(await fs.readFile(path.join(options.directory, "reference/upper floor/plan.pdf"))).toEqual(reference);
    expect(await fs.readFile(path.join(inputsDirectory, "upper floor/plan.pdf"))).toEqual(reference);
    expect(result.checkpoint.files.find(file => file.path === "reference/upper floor/plan.pdf")?.size).toBe(reference.length);
    expect(result.checkpoint.files.some(file => file.path === "AGENT_BRIEF.md")).toBe(false);
    expect(await fs.readFile(path.join(options.directory, "AGENT_BRIEF.md"), "utf8")).toContain(result.checkpoint.id);
    expect(await fs.readFile(path.join(options.directory, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(result.checkpoint.files.some(file => file.path === "CLAUDE.md")).toBe(true);
    const instructions = await fs.readFile(path.join(options.directory, "BUILDERS.md"), "utf8");
    expect(instructions).toContain("unconfirmed");
    expect(instructions).toContain("source/intake.json");
    expect(await fs.readFile(path.join(options.directory, "AGENTS.md"), "utf8")).toContain("source/intake.json");
    expect(instructions).not.toMatch(/dennis|fixture|sample.house/i);
    await expect(inspectArtifact({ projectId: options.id })).rejects.toThrow();
    await expect(buildProjectArtifact(options.id, { authorizeSourceExecution: true })).rejects.toThrow("Project needs authoring: inspect reference/ and BUILDERS.md");
    expect(await fs.readdir(path.join(options.directory, "outputs/artifact"))).toEqual([]);
    const cli = path.resolve(import.meta.dir, "../src/cli.ts");
    const unauthorized = Bun.spawn([process.execPath, cli, "build", options.id], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const unauthorizedError = await new Response(unauthorized.stderr).text();
    expect(await unauthorized.exited).toBe(1);
    expect(unauthorizedError).toContain("--authorize-source-execution");
    expect(await new Response(unauthorized.stdout).text()).toBe("");
    const generatorPath = path.join(options.directory, "source/generate.ts");
    const generator = await fs.readFile(generatorPath, "utf8");
    await fs.writeFile(generatorPath, 'process.stderr.write("diagnostic-marker\\n" + "x".repeat(128 * 1024), () => process.exit(1));\n');
    const failure = await buildProjectArtifact(options.id, { authorizeSourceExecution: true }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("diagnostic-marker");
    expect(failure.message).toContain("[stderr truncated at 4 KiB]");
    expect(Buffer.byteLength(failure.message)).toBeLessThan(4096 + 128);
    await fs.writeFile(generatorPath, generator);

    await fs.writeFile(path.join(options.directory, "assets/plan.json"), JSON.stringify({ version: 1, name: "Known room", walls: [{ id: "wall", a: [0, 0], b: [4, 0] }], cameras: [{ id: "entry", position: [1, 1], lookAt: [2, 2] }] }));
    const outsideBrief = path.join(temporary, "outside-brief.md");
    await fs.writeFile(outsideBrief, "Keep this outside file unchanged.");
    await fs.unlink(path.join(options.directory, "AGENT_BRIEF.md"));
    await fs.symlink(outsideBrief, path.join(options.directory, "AGENT_BRIEF.md"));
    const built = await buildProjectArtifact(options.id, { authorizeSourceExecution: true });
    expect(await fs.readFile(outsideBrief, "utf8")).toBe("Keep this outside file unchanged.");
    expect((await fs.lstat(path.join(options.directory, "AGENT_BRIEF.md"))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(options.directory, "AGENT_BRIEF.md"), "utf8")).toContain(built.checkpoint.id);
    const authorized = Bun.spawn([process.execPath, cli, "build", options.id, "--authorize-source-execution"], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const authorizedOutput = await new Response(authorized.stdout).json();
    expect(await new Response(authorized.stderr).text()).toBe("");
    expect(await authorized.exited).toBe(0);
    expect(authorizedOutput).toEqual({ checkpointId: built.checkpoint.id, artifactHash: built.artifactHash, runtimeHash: built.artifact.runtimeHash });
    expect(built.checkpoint.parentId).toBe(result.checkpoint.id);
    expect(built.artifact.files.map(file => file.path).sort()).toEqual(["outputs/artifact/library/index.json", "outputs/artifact/plan.json"]);
    const bundle = path.join(temporary, "bundle");
    await exportCheckpoint(built.checkpoint.id, bundle);
    process.env.ARCH_HOME = path.join(temporary, "other-store");
    await importCheckpoint(bundle);
    const restored = path.join(temporary, "restored");
    await restoreCheckpoint(built.checkpoint.id, restored, { activate: true });
    expect(await fs.readFile(path.join(restored, "source/intake.json"))).toEqual(intakeBytes);
    expect(await readProjectIntake(restored)).toEqual(intake);
    expect(await fs.readFile(path.join(restored, "reference/upper floor/plan.pdf"))).toEqual(reference);
    expect(await fs.readFile(path.join(restored, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect((await buildProjectArtifact(options.id, { authorizeSourceExecution: true })).artifactHash).toBe(built.artifactHash);
    process.env.ARCH_HOME = path.join(temporary, "store");

    await expect(initializeProject(options)).rejects.toThrow("already registered");
    const existing = path.join(temporary, "existing");
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, "keep.txt"), "keep");
    await expect(initializeProject({ ...options, directory: existing, id: "other-house" })).rejects.toThrow();
    expect(await fs.readFile(path.join(existing, "keep.txt"), "utf8")).toBe("keep");
    await expect(initializeProject({ ...options, directory: path.join(inputsDirectory, "nested"), id: "nested-house" })).rejects.toThrow("overlap");
    const unsafe = path.join(temporary, "unsafe");
    await fs.mkdir(unsafe);
    const rejected = { ...options, inputsDirectory: unsafe, directory: path.join(temporary, "rejected"), id: "rejected-house" };
    await fs.symlink(path.join(inputsDirectory, "brief.md"), path.join(unsafe, "linked.md"));
    await expect(initializeProject(rejected)).rejects.toThrow("Symlink");
    await fs.unlink(path.join(unsafe, "linked.md"));
    for (const name of ["credentials.json", ".env", "source.ts", "image.png.exe", "id_rsa.txt"]) {
      await fs.writeFile(path.join(unsafe, name), "private");
      await expect(initializeProject(rejected)).rejects.toThrow();
      await fs.unlink(path.join(unsafe, name));
    }
    const huge = await fs.open(path.join(unsafe, "large.pdf"), "w");
    await huge.truncate(100 * 1024 * 1024 + 1);
    await huge.close();
    await expect(initializeProject(rejected)).rejects.toThrow("100 MiB");
    await fs.unlink(path.join(unsafe, "large.pdf"));
    for (let index = 0; index <= 100; index++) await fs.writeFile(path.join(unsafe, `${index}.txt`), "x");
    await expect(initializeProject(rejected)).rejects.toThrow("100 reference");
    expect(await fs.access(rejected.directory).then(() => true, () => false)).toBe(false);
    expect((await listProjects()).map(project => project.manifest.id)).toEqual(["new-house"]);
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME;
    else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

function intakePlan(): ProjectIntakePlan {
  return {
    version: 1, brief: "Inspect the supplied drawings.", style: "",
    documents: [
      { id: "doc-1", path: "reference/plan.pdf", page: 1, label: "Ground floor", level: "Ground", revision: "A", role: "primary" },
      { id: "doc-2", path: "reference/plan.pdf", page: 2, label: "Upper floor", role: "supporting" },
      { id: "doc-3", path: "reference/alias.pdf", page: 1, label: "Repeated plan", role: "duplicate", duplicateOf: "doc-1" },
    ],
    pieces: [
      { id: "walls", label: "Walls", scope: "Known footprint", documentIds: ["doc-1"], dependsOn: [], status: "ready", nextAction: "Model known walls." },
      { id: "stairs", label: "Stairs", scope: "Vertical circulation", documentIds: ["doc-1", "doc-2"], dependsOn: ["walls"], status: "blocked", nextAction: "Confirm rise." },
      { id: "furniture", label: "Furniture", scope: "Ground floor", documentIds: ["doc-1"], dependsOn: ["walls"], status: "planned", nextAction: "Inspect style references." },
    ],
  };
}

test("intake contract accepts multiple pages, a direct duplicate and shared dependencies", () => {
  const plan = intakePlan();
  expect(projectIntakeSchema.parse(plan)).toEqual(plan);
});

test("intake can account for three forty-page reference files before pieces are planned", () => {
  const plan = intakePlan();
  plan.pieces = [];
  plan.documents = Array.from({ length: 120 }, (_, index) => ({ id: `page-${index + 1}`, path: `reference/set-${Math.floor(index / 40) + 1}.pdf`, page: index % 40 + 1, label: `Drawing ${index + 1}`, role: "unresolved" }));
  expect(projectIntakeSchema.parse(plan).documents).toHaveLength(120);
});

test("saved intake metadata stays paired with its reference revision after the live source changes", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-intake-revisions-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const inputsDirectory = path.join(temporary, "inputs");
    await fs.mkdir(inputsDirectory);
    await fs.writeFile(path.join(inputsDirectory, "plan.pdf"), "%PDF-1.7\nRevision A\n");
    const directory = path.join(temporary, "project");
    const { project } = await initializeProject({ inputsDirectory, directory, id: "revisions", name: "Revisions", client: { id: "test", name: "Test" } });
    const plan = (await readProjectIntake(directory))!;
    plan.documents[0]!.revision = "A";
    const intakeFile = path.join(directory, "source/intake.json");
    await fs.writeFile(intakeFile, JSON.stringify(plan));
    const first = await saveCheckpoint(project.manifest.id);
    plan.documents[0]!.revision = "B";
    await fs.writeFile(intakeFile, JSON.stringify(plan));
    await fs.writeFile(path.join(directory, "reference/plan.pdf"), "%PDF-1.7\nRevision B\n");
    const second = await saveCheckpoint(project.manifest.id);
    expect((await readCheckpointIntake(first.id))!.documents[0]!.revision).toBe("A");
    expect((await referenceFile({checkpointId: first.id, path: "reference/plan.pdf"})).body.toString()).toContain("Revision A");
    expect((await readCheckpointIntake(second.id))!.documents[0]!.revision).toBe("B");
    expect((await referenceFile({checkpointId: second.id, path: "reference/plan.pdf"})).body.toString()).toContain("Revision B");
    await fs.writeFile(intakeFile, "{");
    await expect(readProjectIntake(directory)).rejects.toThrow();
    expect((await readCheckpointIntake(first.id))!.documents[0]!.revision).toBe("A");
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME;
    else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, {recursive: true, force: true});
  }
});

const invalidIntakes: [string, (plan: ProjectIntakePlan) => void][] = [
  ["duplicate document IDs", plan => { plan.documents[1]!.id = "doc-1"; }],
  ["repeated document page", plan => { plan.documents[1]!.page = 1; }],
  ["duplicate piece IDs", plan => { plan.pieces[1]!.id = "walls"; }],
  ["missing duplicate target", plan => { delete plan.documents[2]!.duplicateOf; }],
  ["dangling duplicate target", plan => { plan.documents[2]!.duplicateOf = "unknown"; }],
  ["self duplicate", plan => { plan.documents[2]!.duplicateOf = "doc-3"; }],
  ["duplicate chains", plan => { plan.documents[1]!.role = "duplicate"; plan.documents[1]!.duplicateOf = "doc-3"; }],
  ["duplicateOf on another role", plan => { plan.documents[0]!.duplicateOf = "doc-2"; }],
  ["dangling document link", plan => { plan.pieces[0]!.documentIds = ["unknown"]; }],
  ["dangling dependency", plan => { plan.pieces[0]!.dependsOn = ["unknown"]; }],
  ["self dependency", plan => { plan.pieces[0]!.dependsOn = ["walls"]; }],
  ["dependency cycle", plan => { plan.pieces[0]!.dependsOn = ["stairs"]; }],
  ["longer dependency cycle", plan => { plan.pieces[0]!.dependsOn = ["stairs"]; plan.pieces[1]!.dependsOn = ["furniture"]; }],
  ["traversal path", plan => { plan.documents[0]!.path = "reference/../plan.pdf"; }],
  ["absolute path", plan => { plan.documents[0]!.path = "/reference/plan.pdf"; }],
  ["backslash path", plan => { plan.documents[0]!.path = "reference\\plan.pdf"; }],
  ["zero page", plan => { plan.documents[0]!.page = 0; }],
  ["fractional page", plan => { plan.documents[0]!.page = 1.5; }],
  ["invalid ID", plan => { plan.documents[0]!.id = "Bad ID"; }],
  ["oversized brief", plan => { plan.brief = "x".repeat(8001); }],
  ["oversized style", plan => { plan.style = "x".repeat(4001); }],
  ["oversized document label", plan => { plan.documents[0]!.label = "x".repeat(161); }],
  ["oversized level", plan => { plan.documents[0]!.level = "x".repeat(161); }],
  ["oversized revision", plan => { plan.documents[0]!.revision = "x".repeat(161); }],
  ["oversized piece label", plan => { plan.pieces[0]!.label = "x".repeat(161); }],
  ["oversized scope", plan => { plan.pieces[0]!.scope = "x".repeat(4001); }],
  ["oversized next action", plan => { plan.pieces[0]!.nextAction = "x".repeat(4001); }],
  ["too many documents", plan => { plan.documents = Array.from({ length: 1001 }, (_, index) => ({ ...plan.documents[0]!, id: `doc-${index}` })); }],
  ["too many pieces", plan => { plan.pieces = Array.from({ length: 101 }, (_, index) => ({ ...plan.pieces[0]!, id: `piece-${index}` })); }],
];
test.each(invalidIntakes)("intake contract rejects %s", (_name, invalidate) => {
  const plan = intakePlan();
  invalidate(plan);
  expect(projectIntakeSchema.safeParse(plan).success).toBe(false);
});

test("intake contract rejects unknown properties at every object level", () => {
  const plan = intakePlan();
  for (const invalid of [
    { ...plan, extra: true },
    { ...plan, documents: [{ ...plan.documents[0]!, extra: true }] },
    { ...plan, pieces: [{ ...plan.pieces[0]!, extra: true }] },
  ]) expect(projectIntakeSchema.safeParse(invalid).success).toBe(false);
});

test("intake source boundaries reject unsafe files and undeclared references while accepting older sources", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-intake-boundary-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const inputsDirectory = path.join(temporary, "inputs");
    await fs.mkdir(inputsDirectory);
    await fs.writeFile(path.join(inputsDirectory, "plan.pdf"), "%PDF-1.7\nSynthetic reference\n");
    await fs.writeFile(path.join(inputsDirectory, "alias.pdf"), "%PDF-1.7\nSynthetic reference\n");
    const directory = path.join(temporary, "project");
    const { project } = await initializeProject({ inputsDirectory, directory, id: "boundary-house", name: "Boundary house", description: "A house from supplied drawings.", client: { id: "test", name: "Test" } });
    const file = path.join(directory, "source/intake.json");
    const initial = await readProjectIntake(directory);
    expect(initial?.brief).toBe(project.manifest.description);
    const plan = intakePlan();
    await fs.writeFile(file, JSON.stringify(plan));
    expect(await readProjectIntake(directory)).toEqual(plan);

    plan.documents[0]!.path = "reference/undeclared.pdf";
    await fs.writeFile(path.join(directory, "reference/undeclared.pdf"), "An existing but undeclared reference.");
    await fs.writeFile(file, JSON.stringify(plan));
    for (const action of [
      () => readProjectIntake(directory),
      () => registerProject(directory),
      () => saveCheckpoint(project.manifest.id),
    ]) await expect(action()).rejects.toThrow("not a project reference");

    await fs.writeFile(file, "{");
    expect((await inspectSource(directory)).manifest.id).toBe(project.manifest.id);
    await expect(readProjectIntake(directory)).rejects.toThrow();
    // Oversized invalid JSON must fail the byte bound before parsing JSON.
    await fs.writeFile(file, "{" + " ".repeat(2 * 1024 * 1024));
    await expect(readProjectIntake(directory)).rejects.toThrow("2 MiB");
    // Count UTF-8 bytes rather than JavaScript string characters.
    await fs.writeFile(file, "é".repeat(1024 * 1024 + 1));
    await expect(readProjectIntake(directory)).rejects.toThrow("2 MiB");
    await fs.unlink(file);
    const outside = path.join(temporary, "outside.json");
    await fs.writeFile(outside, JSON.stringify(initial));
    await fs.symlink(outside, file);
    await expect(readProjectIntake(directory)).rejects.toThrow("Symlink");
    await fs.unlink(file);
    await fs.symlink(path.join(temporary, "missing.json"), file);
    await expect(readProjectIntake(directory)).rejects.toThrow("Symlink");
    await fs.unlink(file);
    await fs.rename(path.join(directory, "source"), path.join(temporary, "outside-source"));
    await fs.symlink(path.join(temporary, "outside-source"), path.join(directory, "source"));
    await expect(readProjectIntake(directory)).rejects.toThrow("Symlink");
    await fs.unlink(path.join(directory, "source"));
    await fs.rename(path.join(temporary, "outside-source"), path.join(directory, "source"));
    expect(await readProjectIntake(directory)).toBeNull();
    expect((await inspectSource(directory)).manifest.id).toBe(project.manifest.id);
    expect((await registerProject(directory)).manifest.id).toBe(project.manifest.id);
    const older = await saveCheckpoint(project.manifest.id);
    expect(older.files.some(file => file.path === "source/intake.json")).toBe(false);
    expect((await listProjects())[0]).not.toHaveProperty("intake");
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME;
    else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
