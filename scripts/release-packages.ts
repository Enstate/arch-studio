import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["config", "project", "viewer", "ui", "viewer-ui", "renderer", "project-tools"] as const;
const { values } = parseArgs({ options: { tag: { type: "string" }, out: { type: "string" } } });
const tag = values.tag;
if (!tag || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
  throw new Error("--tag must be a release tag such as v0.1.0");
}
if (values.out && !isAbsolute(values.out)) throw new Error("--out must be an absolute path");
const version = tag.slice(1);
const output = values.out ?? join(root, ".arch", "releases", tag);
function command(args: string[], cwd = root): Buffer {
  const result = spawnSync(args[0]!, args.slice(1), { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr?.toString() ?? result.error?.message}`);
  return result.stdout;
}
const commit = command(["git", "rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
const taggedCommit = command(["git", "rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).toString().trim();
if (taggedCommit !== commit) throw new Error(`${tag} must point to HEAD before preparing its release`);
const source = (path: string) => command(["git", "show", `${commit}:${path}`]);
const catalog = JSON.parse(source("package.json").toString()).workspaces.catalog as Record<string, string>;
const license = source("LICENSE");
const tracked = command(["git", "ls-tree", "-rz", "--full-tree", commit]).toString().split("\0").filter(Boolean);
const files = tracked.map((entry) => {
  const match = /^(\d+) blob [a-f0-9]+\t(.+)$/.exec(entry);
  return match ? { mode: match[1] as string, path: match[2] as string } : null;
}).filter((entry): entry is { mode: string; path: string } => entry !== null);
function included(path: string): boolean {
  if (path.split("/").some((part) => ["node_modules", ".assets", ".arch", "tests", "fixtures", "__tests__"].includes(part))) return false;
  if (/\.(test|spec)\.[^.]+$/.test(path)) return false;
  return /^(src\/.*\.(ts|tsx|js|jsx|mjs|cjs|css|json)|tsconfig[^/]*\.json|package\.json|postcss\.config\.mjs|components\.json|manifest\.json|plans\/.*\.(json|ts)|template\/.*\.(html|ts|js|css)|scripts\/fetch-assets\.ts)$/.test(path);
}
function manifest(name: string, bytes: Buffer): Buffer {
  const value = JSON.parse(bytes.toString());
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependency, range] of Object.entries(value[section] ?? {}) as [string, string][]) {
      if (range.startsWith("workspace:") || range.startsWith("catalog:")) {
        if (name === "viewer") throw new Error("Viewer runtime manifest requires rewriting; preserve its runtime hash instead");
        if (range.startsWith("workspace:")) {
          const sibling = packages.find((item) => dependency === `@arch/${item}`);
          if (!sibling) throw new Error(`Unknown workspace dependency ${dependency}`);
          value[section][dependency] = `https://github.com/Enstate/arch-studio/releases/download/${tag}/arch-${sibling}-${version}.tgz`;
        } else {
          if (range !== "catalog:" || !catalog[dependency]) throw new Error(`Unknown catalog dependency ${dependency}`);
          value[section][dependency] = catalog[dependency];
        }
      }
    }
  }
  if (name === "viewer") {
    return bytes;
  }
  value.version = version;
  value.license = "MIT";
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
// mkdir without recursive creation of the destination refuses an existing release.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const temporary = await mkdtemp(join(tmpdir(), "arch-release-"));
try {
  const archives: { package: string; file: string; sha256: string; bytes: number }[] = [];
  for (const name of packages) {
    const staging = join(temporary, name);
    const packageRoot = join(staging, "package");
    await mkdir(packageRoot, { recursive: true });
    const prefix = `packages/${name}/`;
    const selected = files.filter((file) => file.path.startsWith(prefix) && included(file.path.slice(prefix.length)));
    if (!selected.some((file) => file.path === `${prefix}package.json`)) throw new Error(`Missing package ${name}`);
    for (const file of selected) {
      if (file.mode !== "100644" && file.mode !== "100755") throw new Error(`Refusing nonregular file ${file.path}`);
      const relative = file.path.slice(prefix.length);
      const destination = join(packageRoot, relative);
      await mkdir(dirname(destination), { recursive: true });
      const bytes = source(file.path);
      await writeFile(destination, relative === "package.json" ? manifest(name, bytes) : bytes, { mode: file.mode === "100755" ? 0o755 : 0o644 });
    }
    await writeFile(join(packageRoot, "LICENSE"), license);
    const file = `arch-${name}-${version}.tgz`;
    command(["tar", "-czf", join(output, file), "-C", staging, "package"]);
    const archive = await readFile(join(output, file));
    archives.push({ package: `@arch/${name}`, file, sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.length });
  }
  await writeFile(join(output, "release.json"), `${JSON.stringify({ schemaVersion: 1, repository: "Enstate/arch-studio", commit, tag, version, archives }, null, 2)}\n`);
  await writeFile(join(output, "SHA256SUMS"), archives.map(({ sha256, file }) => `${sha256}  ${file}\n`).join(""));
  console.log(`Prepared ${archives.length} archives from ${commit} in ${output}`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
