import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectKindSchema } from "@arch/project";
import { initializeProject, refreshProjectRules } from "../src/intake.ts";
import { builderRules, kindGuideReference, projectRules } from "../src/rules.ts";

test("stock rules from an older Studio are refreshed and edited or linked rules are kept", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-rules-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const directory = path.join(temporary, "source");
    await initializeProject({ directory, id: "rules-house", name: "Rules house", client: { id: "test-client", name: "Test Client" } });
    const builders = path.join(directory, "BUILDERS.md"), agents = path.join(directory, "AGENTS.md");
    const current = await fs.readFile(builders, "utf8");
    expect(current).toContain("## Storeys and stairs");
    expect(current).toContain("## Hand edits");
    expect(current).toContain("## Performance");
    expect(await refreshProjectRules(directory)).toEqual([]);

    // The one-floor stock rules a project created before storeys still holds.
    const oneFloor = await fs.readFile(path.join(import.meta.dir, "fixtures/builders-one-floor.md"), "utf8");
    expect(oneFloor).toContain("Plan v1 has one floor plane");
    await fs.writeFile(builders, oneFloor);
    expect(await refreshProjectRules(directory)).toEqual(["BUILDERS.md"]);
    expect(await fs.readFile(builders, "utf8")).toBe(current);

    const edited = `${oneFloor}\nThis project keeps its own stair notes.\n`;
    await fs.writeFile(builders, edited);
    expect(await refreshProjectRules(directory)).toEqual([]);
    expect(await fs.readFile(builders, "utf8")).toBe(edited);

    const outside = path.join(temporary, "outside.md");
    await fs.writeFile(outside, oneFloor);
    await fs.rm(builders);
    await fs.symlink(outside, builders);
    expect(await refreshProjectRules(directory)).toEqual([]);
    expect(await fs.readFile(outside, "utf8")).toBe(oneFloor);
    expect((await fs.readFile(agents, "utf8")).startsWith("# Project rules")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME;
    else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("stock rules from before project kinds refresh, and stock rules follow a changed kind", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-rules-kinds-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const directory = path.join(temporary, "source");
    await initializeProject({ directory, id: "kind-house", name: "Kind house" });
    const builders = path.join(directory, "BUILDERS.md"), agents = path.join(directory, "AGENTS.md");
    // The asset catalog's stock rules, the last ones before facts, kinds and the dependency rule.
    await fs.writeFile(builders, await fs.readFile(path.join(import.meta.dir, "fixtures/builders-catalog.md"), "utf8"));
    await fs.writeFile(agents, await fs.readFile(path.join(import.meta.dir, "fixtures/agents-catalog.md"), "utf8"));
    expect((await refreshProjectRules(directory)).sort()).toEqual(["AGENTS.md", "BUILDERS.md"]);
    expect(await fs.readFile(agents, "utf8")).toBe(projectRules);
    // A project without a kind keeps every guide, so an older house still has its storey rules.
    const unknown = await fs.readFile(builders, "utf8");
    expect(unknown).toBe(builderRules(undefined));
    for (const title of ["General guidance", "Building guide", "Interior guide", "Public space guide", "Landscape guide", "Site guide"]) expect(unknown).toContain(`## ${title}`);
    expect(unknown).toContain("three 0.186.1");

    const manifestPath = path.join(directory, "arch.project.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, facts: { kind: "landscape" } }));
    expect(await refreshProjectRules(directory)).toEqual(["BUILDERS.md"]);
    expect(await fs.readFile(builders, "utf8")).toBe(builderRules("landscape"));
    const edited = `${builderRules("landscape")}\nThis garden keeps its own pond notes.\n`;
    await fs.writeFile(builders, edited);
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, facts: { kind: "building" } }));
    expect(await refreshProjectRules(directory)).toEqual([]);
    expect(await fs.readFile(builders, "utf8")).toBe(edited);
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME;
    else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("each kind's rules carry only what applies, and the skill's guides match them", async () => {
  expect(builderRules("building")).toContain("Never fake an upper storey of a building");
  expect(builderRules("building")).toContain("### Storeys and stairs");
  for (const kind of ["public-space", "landscape", "site"] as const) {
    expect(builderRules(kind)).not.toContain("Never fake an upper storey");
    expect(builderRules(kind)).toContain("ground:true");
    expect(builderRules(kind)).toContain("GeoJSON");
  }
  for (const kind of projectKindSchema.options) {
    const rules = builderRules(kind);
    expect(rules).toContain("## Dependencies");
    expect(rules).toContain("## Project facts");
    const reference = path.join(import.meta.dir, "../../../.agents/skills/arch-generation/references", `${kind}.md`);
    expect(await fs.readFile(reference, "utf8")).toBe(kindGuideReference(kind));
  }
});
