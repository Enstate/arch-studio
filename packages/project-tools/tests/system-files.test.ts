import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasUnsavedChanges, inspectSource, registerProject, saveCheckpoint } from "../src/index.ts";
import { initializeProject } from "../src/intake.ts";

test("Finder and Explorer litter at any depth never breaks or joins a checkpoint", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-system-files-")));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, "store");
  try {
    const directory = path.join(temporary, "source");
    const created = await initializeProject({ directory, id: "littered", name: "Littered" });
    const litter = [".DS_Store", "source/.DS_Store", "assets/library/.DS_Store", "assets/library/Thumbs.db", "source/desktop.ini", "assets/._plan.json"];
    for (const file of litter) await fs.writeFile(path.join(directory, file), "litter");
    expect(await hasUnsavedChanges("littered", "main")).toBe(false);
    await inspectSource(directory);
    await registerProject(directory);
    const saved = await saveCheckpoint("littered");
    expect(saved.id).toBe(created.checkpoint.id);
    expect(saved.files.some(file => /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/.test(file.path))).toBe(false);

    // Other hidden files are still refused, so secrets never slip in under the same rule.
    await fs.writeFile(path.join(directory, "source/.env"), "TOKEN=synthetic");
    await expect(saveCheckpoint("littered")).rejects.toThrow("disallowed project path");
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
