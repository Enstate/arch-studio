import { accessSync, constants, statSync } from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Local PATH resolution only. No login shells or per-account configuration.
export function executablePath(
  command: string,
  platform = process.platform,
  env = process.env,
): string | undefined {
  const searchPath = platform === "win32" ? (env.PATH ?? env.Path ?? env.path) : env.PATH;
  const paths =
    NodePath.isAbsolute(command) || command.includes(NodePath.sep)
      ? [command]
      : (searchPath ?? "")
          .split(NodePath.delimiter)
          .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
          .filter(Boolean)
          .map((directory) => NodePath.join(directory, command));
  // Windows runs only PATHEXT files. npm also writes an extensionless POSIX shim next to
  // `claude.cmd`, which Windows cannot execute.
  const pathExtensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const extensions =
    platform !== "win32"
      ? [""]
      : pathExtensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()))
        ? [""]
        : pathExtensions;
  for (const path of paths)
    for (const extension of extensions) {
      const candidate = path + extension;
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return NodePath.resolve(candidate);
      } catch {
        /* Try the next PATH entry. */
      }
    }
  return undefined;
}
export const SpawnExecutableResolution = Context.Reference<typeof executablePath>(
  "arch/agent/ExecutableResolution",
  { defaultValue: () => executablePath },
);

const windowsLauncher = (path: string) => /\.(cmd|bat|ps1)$/i.test(path);

/**
 * Native executables inside the npm packages behind Windows `claude.cmd` and `codex.cmd`
 * launchers, relative to the launcher directory. Codex's launcher picks its platform
 * package the same way.
 */
function npmNativeEntries(launcher: string, arch: string): string[][] {
  const name = NodePath.basename(launcher).replace(/\.(cmd|bat|ps1)$/i, "").toLowerCase();
  if (name === "claude") return [["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"]];
  if (name !== "codex") return [];
  const cpu = arch === "arm64" ? "arm64" : "x64";
  const triple = cpu === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const platformPackage = ["@openai", `codex-win32-${cpu}`];
  return [
    ["node_modules", "@openai", "codex", "node_modules", ...platformPackage, "vendor", triple, "bin", "codex.exe"],
    ["node_modules", ...platformPackage, "vendor", triple, "bin", "codex.exe"],
    ["node_modules", "@openai", "codex", "vendor", triple, "bin", "codex.exe"],
    ["node_modules", "@openai", "codex", "vendor", triple, "codex", "codex.exe"],
  ];
}

/**
 * Resolves a command to a file that can be spawned without a shell. Windows npm
 * launchers are followed to the native executable they wrap. Returns undefined when
 * the command is missing or only a launcher without a known native entry exists.
 */
export function launchablePath(
  command: string,
  platform = process.platform,
  env = process.env,
  arch = process.arch,
): { found: string; executable?: string } | undefined {
  const found = executablePath(command, platform, env);
  if (!found) return undefined;
  if (platform !== "win32" || !windowsLauncher(found)) return { found, executable: found };
  const directory = NodePath.dirname(found);
  const executable = npmNativeEntries(found, arch)
    .map((segments) => NodePath.join(directory, ...segments))
    .find(isFile);
  return executable ? { found, executable } : { found };
}

export const resolveSpawnCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { env?: NodeJS.ProcessEnv; extendEnv?: boolean } = {},
) => Effect.sync(() => {
  const resolved = launchablePath(command, process.platform, options.env ?? process.env);
  // Native binaries and JavaScript entry points can be spawned without a shell.
  // Reject Windows shell launchers instead of interpolating agent input into cmd.exe.
  if (resolved && !resolved.executable)
    throw new Error(`Use a native executable for ${command}. Shell launchers are unsupported.`);
  return { command: resolved?.executable ?? command, args: [...args], shell: false };
});
