import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configs: string[] = [];
if (existsSync(join(root, "scripts/tsconfig.json"))) configs.push("scripts/tsconfig.json");
for (const parent of ["apps", "packages"]) {
  for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
    const config = join(parent, entry.name, "tsconfig.json");
    if (entry.isDirectory() && existsSync(join(root, config))) configs.push(config);
  }
}
for (const config of configs) {
  console.log(`Checking ${config}`);
  const child = spawnSync(process.execPath, ["--check", "--tsconfig-override", config], { cwd: root, stdio: "inherit" });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
