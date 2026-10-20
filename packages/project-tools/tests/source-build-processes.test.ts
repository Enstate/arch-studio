import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for owned generator process");
}

test("server SIGTERM stops its detached generator and descendant", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-processes-")));
  let generator: { parent: number; descendant: number } | undefined;
  let runner: ReturnType<typeof spawn> | undefined;
  try {
    const project = path.join(directory, "project");
    await fs.mkdir(path.join(project, "source"), { recursive: true });
    await fs.writeFile(path.join(project, "arch.project.json"), JSON.stringify({ schemaVersion: 2, id: "process-house", name: "Process house", client: { id: "internal", name: "Internal" }, description: "", entry: "source/generate.ts", runtime: { name: "arch-viewer", version: "0.1.0", threeVersion: "0.186.1" }, views: [], assumptions: [], references: [], artifacts: [] }));
    await fs.writeFile(path.join(project, "arch.context.json"), JSON.stringify({ goal: "Test", driver: "Test", decisions: [], unresolved: [], nextAction: "Test", instructionVersion: "1" }));
    await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ dependencies: { three: "0.186.1" } }));
    await fs.writeFile(path.join(project, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { three: "0.186.1" } }, "node_modules/three": { version: "0.186.1", resolved: "https://registry.npmjs.org/three/-/three-0.186.1.tgz", integrity: "sha512-test" } } }));
    await fs.writeFile(path.join(project, "source/generate.ts"), `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.env.ARCH_ARTIFACT_OUTPUT + "/pids.json", JSON.stringify({ parent: process.pid, descendant: child.pid }));
      setInterval(() => {}, 1000);
    `);
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const executable = path.join(directory, "server.ts");
    await fs.writeFile(executable, `
      import { registerProject, buildProjectArtifact } from ${JSON.stringify(entry)};
      // Match the packaged server's immediate shutdown handler. Generator cleanup
      // must run before this handler even though it was installed earlier.
      process.on("SIGTERM", () => process.exit(0));
      await registerProject(${JSON.stringify(project)});
      await buildProjectArtifact("process-house", { authorizeSourceExecution: true });
    `);
    runner = spawn(process.execPath, [executable], { env: { ...process.env, ARCH_HOME: path.join(directory, "store") }, stdio: "ignore" });
    const exited = new Promise<number | null>((resolve, reject) => {
      runner!.once("error", reject);
      runner!.once("exit", resolve);
    });
    generator = await until(async () => {
      try { return JSON.parse(await fs.readFile(path.join(project, "outputs/artifact/pids.json"), "utf8")); } catch { return undefined; }
    });
    expect(alive(generator!.parent)).toBe(true);
    expect(alive(generator!.descendant)).toBe(true);
    runner.kill("SIGTERM");
    expect(await exited).toBe(0);
    await until(async () => !alive(generator!.parent) && !alive(generator!.descendant) ? true : undefined);
    expect(alive(generator!.parent)).toBe(false);
    expect(alive(generator!.descendant)).toBe(false);
  } finally {
    if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    if (generator) { try { process.kill(-generator.parent, "SIGKILL"); } catch {} }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 15_000);
