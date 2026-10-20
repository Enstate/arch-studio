import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { buildProjectArtifact, inspectProject, listProjects, studioStoreDirectory } from "@arch/project-tools";
import { initializeProject } from "@arch/project-tools/intake";

const id = "sample-house";
const existing = (await listProjects()).find(project => project.manifest.id === id);
if (existing) {
  console.log(`Sample house already registered at ${existing.directory}. Existing work was preserved.`);
  process.exit(0);
}
const directory = path.resolve(process.argv[2] ?? path.join(studioStoreDirectory(), "examples", id));
if (directory === homedir()) throw new Error("Choose a new project directory.");
await mkdir(path.dirname(directory), { recursive: true });
const reference = await realpath(await mkdtemp(path.join(tmpdir(), "arch-demo-reference-")));
try {
  const plan = JSON.parse(await readFile(new URL("../packages/viewer/plans/sample-house/plan.json", import.meta.url), "utf8"));
  // This explicit demo adapts our synthetic house to procedural rendering.
  // No shared downloaded library is needed and no customer inputs are used.
  delete plan.environment;
  delete plan.source;
  for (const material of Object.values(plan.materials ?? {}) as Record<string, unknown>[]) {
    delete material.pbr; delete material.pbrColor; delete material.texture;
  }
  for (const item of plan.furniture ?? []) delete item.model;
  await writeFile(path.join(reference, "sample-house.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await initializeProject({ inputsDirectory: reference, directory, id, name: "Sample house", client: { id: "examples", name: "Examples" }, description: "Synthetic house for learning Arch Studio. No customer data." });
  await writeFile(path.join(directory, "assets", "plan.json"), `${JSON.stringify(plan)}\n`);
  const built = await buildProjectArtifact(id, { authorizeSourceExecution: true });
  const project = await inspectProject(id);
  console.log(JSON.stringify({ project: project.project.manifest.name, directory, checkpointId: built.checkpoint.id }));
} finally { await rm(reference, { recursive: true, force: true }); }
