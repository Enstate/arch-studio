import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerProject, restoreCheckpoint } from "@arch/project-tools";
import { initializeProject } from "@arch/project-tools/intake";
import { changeCatalog, localCatalog } from "./local-catalog";

test("catalog serializes edits and rolls back a process killed during a transaction", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "arch-catalog-")));
  const prior = process.env.ARCH_HOME;
  process.env.ARCH_HOME = directory;
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => changeCatalog(async catalog => {
      await new Promise(resolve => setTimeout(resolve, 1));
      catalog.clients.push({ id: `client-${index}`, name: `Client ${index}` });
    })));
    expect((await changeCatalog(catalog => catalog.clients)).length).toBe(8);
    const module = new URL("./local-catalog.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["-e", `import {changeCatalog} from ${JSON.stringify(module)}; await changeCatalog(async catalog => { catalog.clients.push({id:'uncommitted',name:'Uncommitted'}); console.log('transaction-open'); await new Promise(()=>{}); });`], { env: { PATH: process.env.PATH, ARCH_HOME: directory }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Child transaction did not start")), 5000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.stdout.on("data", value => { if (String(value).includes("transaction-open")) { clearTimeout(timeout); resolve(); } });
      });
      await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
      const clients = await changeCatalog(catalog => catalog.clients);
      expect(clients).toHaveLength(8);
      expect(clients.some(client => client.id === "uncommitted")).toBe(false);
      await changeCatalog(catalog => { catalog.clients.push({ id: "after-crash", name: "After crash" }); });
      expect(await changeCatalog(catalog => catalog.clients.length)).toBe(9);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  } finally {
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await rm(directory, { recursive: true, force: true });
  }
});

test("source display names and changed client IDs leave other projects available", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "arch-source-bindings-")));
  const prior = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(directory, "store");
  try {
    const inputsDirectory = path.join(directory, "inputs");
    await mkdir(inputsDirectory);
    await writeFile(path.join(inputsDirectory, "brief.txt"), "Synthetic reference");
    await changeCatalog(catalog => { catalog.clients.push({ id: "client", name: "Studio display name" }); });
    const first = await initializeProject({ inputsDirectory, directory: path.join(directory, "first"), id: "first", name: "First", client: { id: "client", name: "Source display name" } });
    const second = await initializeProject({ inputsDirectory, directory: path.join(directory, "second"), id: "second", name: "Second", client: { id: "client", name: "Another source display name" } });
    const original = await localCatalog();
    expect(original.clients).toEqual([{ id: "client", name: "Studio display name" }]);
    expect(original.projects).toHaveLength(2);
    const manifestPath = path.join(first.project.directory, "arch.project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.client = { id: "changed-client", name: "Changed client" };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await registerProject(first.project.directory);
    const isolated = await localCatalog();
    expect(isolated.clients).toEqual(original.clients);
    expect(isolated.projects).toEqual(original.projects);
    const destination = path.join(directory, "restored");
    await expect(restoreCheckpoint(second.checkpoint.id, destination)).rejects.toThrow("activate: true");
    expect((await restoreCheckpoint(second.checkpoint.id, destination, { activate: true })).directory).toBe(destination);
  } finally {
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
