import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs one `check-types:<project>` script per tsconfig project. A new project
// without its scoped script fails here instead of going unchecked.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scripts: Record<string, string> = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const projects: string[] = [];
if (existsSync(join(root, "scripts/tsconfig.json"))) projects.push("scripts");
for (const parent of ["apps", "packages"]) {
  for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
    const project = join(parent, entry.name);
    if (entry.isDirectory() && existsSync(join(root, project, "tsconfig.json"))) projects.push(project);
  }
}
for (const project of projects) {
  const script = `check-types:${basename(project)}`;
  if (!scripts[script]) {
    console.error(`${project}/tsconfig.json has no "${script}" script in package.json`);
    process.exit(1);
  }
  console.log(`Checking ${project}/tsconfig.json`);
  const child = spawnSync(process.execPath, ["run", script], { cwd: root, stdio: "inherit" });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
