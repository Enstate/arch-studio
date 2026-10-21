import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeProject, refreshProjectRules } from "../src/intake.ts";

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
