import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../src/intake";
import { listProjects, registerProject } from "../src/index";

test("a killed source catalog writer does not block the next real registration", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "arch-catalog-crash-")));
  const prior = process.env.ARCH_HOME;
  let writer: ReturnType<typeof spawn> | undefined;
  try {
    const store = path.join(temporary, "store");
    process.env.ARCH_HOME = store;
    const inputs = path.join(temporary, "inputs");
    const directory = path.join(temporary, "source");
    await fs.mkdir(inputs);
    await fs.writeFile(path.join(inputs, "brief.txt"), "Synthetic room.");
    await initializeProject({ inputsDirectory: inputs, directory, id: "crash-project", name: "Crash project", client: { id: "synthetic", name: "Synthetic" } });
    // Pause at the real atomic catalog write while its SQLite transaction is held.
    const script = `import {promises as fs} from 'node:fs';
      import {registerProject} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/index.ts"))};
      const rename=fs.rename; fs.rename=async (...args)=>{if(args[1]===${JSON.stringify(path.join(store, "catalog.json"))}){console.log('writer-held');await new Promise(()=>{});}return rename(...args);};
      await registerProject(${JSON.stringify(directory)});`;
    writer = spawn(process.execPath, ["-e", script], { env: { ...process.env, ARCH_HOME: store }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => writer!.once("exit", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Catalog writer did not reach atomic write")), 5000);
      writer!.stdout!.on("data", chunk => { if (String(chunk).includes("writer-held")) { clearTimeout(timeout); resolve(); } });
      writer!.once("error", error => { clearTimeout(timeout); reject(error); });
      writer!.once("exit", code => { clearTimeout(timeout); reject(new Error(`Writer exited early: ${code}`)); });
    });
    writer.kill("SIGKILL");
    await exited;
    expect((await registerProject(directory)).manifest.id).toBe("crash-project");
    expect((await listProjects()).map(project => project.manifest.id)).toEqual(["crash-project"]);
    expect(await fs.access(path.join(store, "catalog.lock")).then(() => true, () => false)).toBe(false);
  } finally {
    writer?.kill("SIGKILL");
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
