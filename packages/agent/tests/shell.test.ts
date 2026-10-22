import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executablePath, launchablePath } from "../src/shared/shell.ts";

const pathExt = ".com;.exe;.bat;.cmd;.vbs;.js";
// npm writes a POSIX shim, a cmd launcher and a PowerShell launcher for each global bin.
function npmPrefix() {
  const prefix = mkdtempSync(join(tmpdir(), "arch-npm-"));
  for (const name of ["claude", "codex"])
    for (const suffix of ["", ".cmd", ".ps1"]) writeFileSync(join(prefix, name + suffix), "");
  return prefix;
}
function file(...segments: string[]) {
  mkdirSync(join(...segments.slice(0, -1)), { recursive: true });
  writeFileSync(join(...segments), "");
  return join(...segments);
}

test("Windows resolution skips the extensionless npm shim", () => {
  const prefix = npmPrefix();
  expect(executablePath("claude", "win32", { Path: `"${prefix}"`, PATHEXT: pathExt })).toBe(join(prefix, "claude.cmd"));
});

test("Windows npm launchers resolve to the native executables they wrap", () => {
  const prefix = npmPrefix();
  const claude = file(prefix, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const codex = file(prefix, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  const env = { PATH: prefix, PATHEXT: pathExt };
  expect(launchablePath("claude", "win32", env, "x64")).toEqual({ found: join(prefix, "claude.cmd"), executable: claude });
  expect(launchablePath("codex", "win32", env, "x64")).toEqual({ found: join(prefix, "codex.cmd"), executable: codex });
  expect(launchablePath("codex", "win32", env, "arm64")).toEqual({ found: join(prefix, "codex.cmd") });
});

test("A native Windows install is used directly", () => {
  const bin = mkdtempSync(join(tmpdir(), "arch-bin-"));
  const claude = file(bin, "claude.exe");
  expect(launchablePath("claude", "win32", { PATH: bin, PATHEXT: pathExt })).toEqual({ found: claude, executable: claude });
});
