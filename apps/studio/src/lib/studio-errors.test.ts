import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discardBranchChanges, inspectSource } from "@arch/project-tools";
import { initializeProject } from "@arch/project-tools/intake";
import { failureDetails, studioFailure } from "./studio-errors";
import { reportedFailure } from "./studio-log.server";

async function failure(run: () => Promise<unknown>) {
  try { await run(); } catch (error) { return reportedFailure(error) as Error; }
  throw new Error("Expected a failure");
}

test("a project file over its schema limit names the file and field, and restoring the saved version repairs it", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "arch-errors-")));
  const prior = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(root, "store");
  try {
    const { project } = await initializeProject({ directory: path.join(root, "plaza"), id: "plaza", name: "Plaza", client: { id: "client", name: "Client" } });
    const contextFile = path.join(project.directory, "arch.context.json");
    const context = JSON.parse(await readFile(contextFile, "utf8")) as Record<string, unknown>;
    await writeFile(contextFile, JSON.stringify({ ...context, driver: "x".repeat(200) }));
    const tooLong = await failure(() => inspectSource(project.directory));
    expect(studioFailure(tooLong, "es").message).toBe("El archivo arch.context.json no es válido: driver tiene más de 160 caracteres.");
    expect(studioFailure(tooLong, "en").message).toBe("The file arch.context.json isn't valid: driver is longer than 160 characters.");
    expect(studioFailure(tooLong, "en").details).toBeUndefined();
    // The file's own text never reaches the message or the copied details.
    expect(failureDetails(tooLong, "en")).not.toContain("xxxxxxxxxx");
    expect(failureDetails(tooLong, "en")).toContain("Code: ARCH_PROJECT_FILE");

    const { goal: _goal, ...withoutGoal } = context;
    await writeFile(contextFile, JSON.stringify({ ...withoutGoal, extra: true }));
    expect(studioFailure(await failure(() => inspectSource(project.directory)), "de").message).toBe("Die Datei arch.context.json ist ungültig: goal fehlt; extra gehört nicht hierher.");
    await writeFile(contextFile, "{ not json");
    expect(studioFailure(await failure(() => inspectSource(project.directory)), "pt").message).toBe("O arquivo arch.context.json não é válido: não dá para ler como JSON.");

    // The restore reads only the saved checkpoint, so the broken folder does not stop it.
    await discardBranchChanges("plaza", "main");
    expect((await inspectSource(project.directory)).manifest.id).toBe("plaza");
  } finally {
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("copied details carry the code and message without capability URLs or tokens", () => {
  const token = "a".repeat(64);
  const details = failureDetails({ name: "Error", message: `Export failed at http://127.0.0.1:3101/api/exports/x/${token} for /Users/someone/Projects/plaza` }, "en");
  expect(details).toContain("Code: none");
  expect(details).not.toContain("127.0.0.1");
  expect(details).not.toContain(token);
  expect(details).not.toContain("someone");
  expect(studioFailure({ message: "ARCH_RESTORE_BUSY" }, "es").message).toBe("Hay una ronda o una generación en curso en este proyecto. Restáuralo cuando termine.");
});
