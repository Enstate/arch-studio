import { tokenizeCliArgs } from "../../shared/cliArgs.ts";


export const resolveCodexLaunchArgs = (launchArgs?: string) => launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

/**
 * `-c` overrides that give the app server streamable HTTP MCP servers for this session. Codex
 * parses each value as TOML, and a JSON string is a valid TOML string. Tools may download and
 * convert assets, so a call gets ten minutes instead of Codex's default minute.
 */
export const codexMcpServerArgs = (servers: Readonly<Record<string, { url: string }>>): Array<string> =>
  Object.entries(servers).flatMap(([name, server]) => [
    "-c",
    `mcp_servers.${name}.url=${JSON.stringify(server.url)}`,
    "-c",
    `mcp_servers.${name}.tool_timeout_sec=600`,
  ]);

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
