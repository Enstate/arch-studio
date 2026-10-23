import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectFactsSchema, viewerProjectManifestSchema } from "@arch/project";
import { verifyCheckpointManifest } from "@arch/project/integrity";
import { createBranch, listProjects, projectBranches } from "../src/index.ts";
import { assignProjectClient, initializeProject, updateProjectFacts } from "../src/intake.ts";

async function withStore(prefix: string, run: (temporary: string) => Promise<void>) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    await run(temporary);
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
const manifestOf = async (directory: string) => viewerProjectManifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory, "arch.project.json"), "utf8")));

test("facts accept confirmed metres and degrees and reject anything else", () => {
  const plaza = { kind: "public-space", location: { label: "Plaza de Armas, Santiago", latitude: -33.4378, longitude: -70.6505 }, storeyHeight: 3.2, north: 359.5 };
  expect(projectFactsSchema.parse(plaza)).toEqual(plaza);
  expect(projectFactsSchema.parse({})).toEqual({});
  for (const facts of [
    { kind: "house" },
    { north: 360 },
    { north: -1 },
    { storeyHeight: 1.5 },
    { storeyHeight: 12 },
    { storeyHeight: Number.POSITIVE_INFINITY },
    { location: { label: "", latitude: 0, longitude: 0 } },
    { location: { label: "Pole", latitude: 91, longitude: 0 } },
    { location: { label: "Dateline", latitude: 0, longitude: 181 } },
    { location: { label: "Extra", latitude: 0, longitude: 0, altitude: 500 } },
    { units: "feet" },
  ]) expect(projectFactsSchema.safeParse(facts).success).toBe(false);
});

test("a project starts from a name and facts, and hosted verification accepts its checkpoint", async () => {
  await withStore("arch-facts-create-", async (temporary) => {
    const directory = path.join(temporary, "plaza");
    const facts = { kind: "public-space" as const, location: { label: "Synthetic plaza", latitude: 40.4168, longitude: -3.7038 }, north: 12 };
    const created = await initializeProject({ directory, id: "facts-plaza", name: "Synthetic plaza", facts });
    const manifest = await manifestOf(directory);
    expect(manifest.facts).toEqual(facts);
    expect(manifest.client).toEqual({ id: "local", name: "Local" });
    // north is confirmed, so the seeded review no longer asks about orientation.
    expect(manifest.assumptions.find(item => item.id === "geometry-review")?.description).toBe("Survey units, scale, site extents and ground levels require input review before authoring.");
    const builders = await fs.readFile(path.join(directory, "BUILDERS.md"), "utf8");
    expect(builders).toContain("This project is a public space");
    expect(builders).toContain("## Public space guide");
    expect(builders).not.toContain("## Building guide");
    expect(builders).not.toContain("Never fake an upper storey");
    expect(await fs.readFile(path.join(directory, "AGENTS.md"), "utf8")).toContain("confirmed by the user");
    expect((await verifyCheckpointManifest(created.checkpoint)).project).toEqual(manifest);

    // Without facts the seeded review and the manifest are what they always were.
    const house = path.join(temporary, "house");
    await initializeProject({ directory: house, id: "facts-house", name: "House", client: { id: "test", name: "Test" } });
    const plain = await manifestOf(house);
    expect("facts" in plain).toBe(false);
    expect(plain.assumptions[0]!.description).toBe("Plan units, scale, ceiling heights, openings and orientation require input review before authoring.");
  });
});

test("name and facts change on a branch with a saved version, and a failed save changes nothing", async () => {
  await withStore("arch-facts-update-", async (temporary) => {
    const directory = path.join(temporary, "source");
    const created = await initializeProject({ directory, id: "facts-update", name: "Square", facts: { kind: "building" } });
    expect(await fs.readFile(path.join(directory, "BUILDERS.md"), "utf8")).toContain("## Building guide");

    const facts = { kind: "public-space" as const, storeyHeight: 3, north: 45 };
    const saved = await updateProjectFacts("facts-update", "main", { name: "Town square", facts });
    expect(saved.parentId).toBe(created.checkpoint.id);
    expect(saved.project.name).toBe("Town square");
    expect(saved.project.schemaVersion === 2 && saved.project.facts).toEqual(facts);
    expect((await listProjects())[0]!.checkpointId).toBe(saved.id);
    // Unedited stock rules follow the new kind, and the seeded review drops what is now confirmed.
    const builders = await fs.readFile(path.join(directory, "BUILDERS.md"), "utf8");
    expect(builders).toContain("## Public space guide");
    expect(builders).not.toContain("## Building guide");
    const review = "Survey units, scale, site extents and ground levels require input review before authoring.";
    expect(saved.project.assumptions[0]!.description).toBe(review);
    expect(saved.brief.unresolved).toContain(review);

    // A save that cannot happen leaves the manifest, context and rules as they were.
    const before = await Promise.all(["arch.project.json", "arch.context.json", "BUILDERS.md"].map(name => fs.readFile(path.join(directory, name), "utf8")));
    await fs.writeFile(path.join(directory, "stray.txt"), "not project source");
    await expect(updateProjectFacts("facts-update", "main", { name: "Renamed", facts: { kind: "landscape" } })).rejects.toThrow("disallowed project path");
    expect(await Promise.all(["arch.project.json", "arch.context.json", "BUILDERS.md"].map(name => fs.readFile(path.join(directory, name), "utf8")))).toEqual(before);
    await fs.rm(path.join(directory, "stray.txt"));

    await expect(updateProjectFacts("facts-update", "main", { name: "Square", facts: { north: 400 } })).rejects.toThrow();
    // The brief changes only when one is given, and a failed save leaves it as it was.
    const briefed = await updateProjectFacts("facts-update", "main", { name: "Town square", facts, description: "Shade for the market days." });
    expect(briefed.project.description).toBe("Shade for the market days.");
    expect((await updateProjectFacts("facts-update", "main", { name: "Square", facts })).project.description).toBe("Shade for the market days.");
    await fs.writeFile(path.join(directory, "stray.txt"), "not project source");
    await expect(updateProjectFacts("facts-update", "main", { name: "Square", facts, description: "Lost" })).rejects.toThrow("disallowed project path");
    expect((await manifestOf(directory)).description).toBe("Shade for the market days.");
    await fs.rm(path.join(directory, "stray.txt"));
    await expect(updateProjectFacts("facts-update", "main", { name: "Square", facts, description: "x".repeat(4001) })).rejects.toThrow();
    const cleared = await updateProjectFacts("facts-update", "main", { name: "Square", facts: {} });
    expect("facts" in cleared.project).toBe(false);
  });
});

test("a project moves to another client on every branch", async () => {
  await withStore("arch-facts-client-", async (temporary) => {
    const directory = path.join(temporary, "source");
    const created = await initializeProject({ directory, id: "client-move", name: "Moved", client: { id: "first", name: "First" } });
    await createBranch("client-move", { name: "option-b", from: created.checkpoint.id });
    const moved = await assignProjectClient("client-move", { id: "second", name: "Second" });
    expect(moved.map(entry => entry.branch).sort()).toEqual(["main", "option-b"]);
    for (const entry of moved) expect(entry.checkpoint.project.client).toEqual({ id: "second", name: "Second" });
    for (const line of (await projectBranches("client-move")).branches) expect((await manifestOf(line.directory)).client.id).toBe("second");
    expect((await listProjects())[0]!.manifest.client.id).toBe("second");
    await expect(assignProjectClient("client-move", { id: "Not A Slug", name: "Bad" })).rejects.toThrow();
    expect((await manifestOf(directory)).client.id).toBe("second");

    // One branch that cannot save puts every branch, folder and head, back on the current client.
    const lines = (await projectBranches("client-move")).branches;
    const blocked = lines.find(line => line.name !== lines[0]!.name)!;
    await fs.writeFile(path.join(blocked.directory, "stray.txt"), "not project source");
    await expect(assignProjectClient("client-move", { id: "third", name: "Third" })).rejects.toThrow("disallowed project path");
    for (const line of (await projectBranches("client-move")).branches) expect((await manifestOf(line.directory)).client.id).toBe("second");
    expect((await listProjects())[0]!.manifest.client.id).toBe("second");
  });
});
