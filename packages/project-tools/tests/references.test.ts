import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectIntake, listProjects } from "../src/index.ts";
import { addReferences, initializeProject } from "../src/intake.ts";

test("projects start without references and take files later as unresolved documents", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-references-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const directory = path.join(temporary, "source");
    const created = await initializeProject({ directory, id: "empty-house", name: "Empty house", client: { id: "local", name: "Local" } });
    expect(created.project.manifest.references).toEqual([]);
    expect((await readProjectIntake(directory))?.documents).toEqual([]);

    const saved = await addReferences("empty-house", "main", [{ name: "plan.pdf", data: new TextEncoder().encode("%PDF-1.7\nsynthetic") }, { name: "plan.pdf", data: new TextEncoder().encode("%PDF-1.7\nsecond") }]);
    expect(saved.parentId).toBe(created.checkpoint.id);
    expect(saved.project.references.map(reference => reference.path)).toEqual(["reference/plan.pdf", "reference/plan 2.pdf"]);
    expect((await readProjectIntake(directory))?.documents.map(document => [document.id, document.path, document.role])).toEqual([["doc-1", "reference/plan.pdf", "unresolved"], ["doc-2", "reference/plan 2.pdf", "unresolved"]]);
    expect((await listProjects())[0]!.checkpointId).toBe(saved.id);

    const manifest = await fs.readFile(path.join(directory, "arch.project.json"), "utf8");
    await expect(addReferences("empty-house", "main", [{ name: "notes.md", data: new TextEncoder().encode("ok") }, { name: "tool.exe", data: new Uint8Array([1]) }])).rejects.toThrow("Unsupported reference file");
    expect(await fs.readFile(path.join(directory, "arch.project.json"), "utf8")).toBe(manifest);
    await expect(fs.access(path.join(directory, "reference/notes.md"))).rejects.toThrow();
    await expect(addReferences("empty-house", "main", [{ name: ".env", data: new Uint8Array([1]) }])).rejects.toThrow("Private");
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
