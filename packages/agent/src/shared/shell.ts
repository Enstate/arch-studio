import { accessSync, constants, statSync } from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

// Local PATH resolution only. No login shells or per-account configuration.
export function executablePath(
  command: string,
  platform = process.platform,
  env = process.env,
): string | undefined {
  const paths =
    NodePath.isAbsolute(command) || command.includes(NodePath.sep)
      ? [command]
      : (env.PATH ?? "")
          .split(NodePath.delimiter)
          .map((directory) => NodePath.join(directory, command));
  const extensions =
    platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
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
export const resolveSpawnCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { env?: NodeJS.ProcessEnv; extendEnv?: boolean } = {},
) => Effect.sync(() => {
  const resolved = executablePath(command, process.platform, options.env ?? process.env) ?? command;
  // Native binaries and JavaScript entry points can be spawned without a shell.
  // Reject Windows shell launchers instead of interpolating agent input into cmd.exe.
  if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(resolved))
    throw new Error(`Use a native executable for ${command}. Shell launchers are unsupported.`);
  return { command: resolved, args: [...args], shell: false };
});
