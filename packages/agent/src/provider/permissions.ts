import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeMode } from "../contracts/index.ts";

const WRITE_TOOLS = new Set(["edit", "write", "notebookedit", "multiedit"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "ls"]);

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling link must not be treated as a new regular file inside cwd.
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Dangling symlink");
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent), relative(parent, path));
  }
}

export async function pathInsideProject(cwd: string, path: string): Promise<boolean> {
  try {
    // CLI tools may expand home shorthand or trim their path input. Do not
    // auto-approve a spelling whose meaning can differ from node:path.
    if (path !== path.trim() || path === "~" || path.startsWith("~/")) return false;
    const root = await realpath(cwd);
    const target = await canonicalPath(resolve(cwd, path));
    const difference = relative(root, target);
    return (
      difference === "" ||
      (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`))
    );
  } catch {
    return false;
  }
}

export async function claudeToolPermission(
  cwd: string,
  mode: RuntimeMode,
  toolName: string,
  input: Record<string, unknown>,
): Promise<"allow" | "ask" | "deny"> {
  // Full access is the user's explicit choice: no prompts for any tool or path.
  if (mode === "full-access") return "allow";
  const name = toolName.toLowerCase();
  // Edit turns run Bash inside the sandbox configured with allowUnsandboxedCommands: false.
  if (name === "bash" && mode === "auto-accept-edits") return "allow";
  const writes = WRITE_TOOLS.has(name);
  if (writes && mode === "approval-required") return "deny";
  if (!writes && !READ_TOOLS.has(name)) return "ask";
  const paths = [input.file_path, input.notebook_path, input.path].filter(
    (value): value is string => typeof value === "string",
  );
  if (Array.isArray(input.edits))
    for (const edit of input.edits) {
      if (
        edit &&
        typeof edit === "object" &&
        "file_path" in edit &&
        typeof edit.file_path === "string"
      )
        paths.push(edit.file_path);
    }
  if (writes && paths.length === 0) return "ask";
  // Glob's pattern can carry a path independently of its search directory.
  if (name === "glob" && typeof input.pattern === "string") paths.push(input.pattern);
  for (const path of paths.length ? paths : [cwd]) {
    if (!(await pathInsideProject(cwd, path))) return "ask";
  }
  return "allow";
}
