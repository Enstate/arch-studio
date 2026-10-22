import { expect, test } from "bun:test";
import { codexMcpServerArgs, codexSessionAppServerArgs } from "../src/provider/Layers/codexLaunchArgs.ts";

test("a round's MCP servers reach the Codex app server as streamable HTTP config overrides", () => {
  const args = codexMcpServerArgs({ arch: { url: "http://127.0.0.1:3101/api/mcp/abc" } });
  expect(args).toEqual(["-c", 'mcp_servers.arch.url="http://127.0.0.1:3101/api/mcp/abc"', "-c", "mcp_servers.arch.tool_timeout_sec=600"]);
  expect(codexSessionAppServerArgs(args, undefined)).toEqual(["app-server", ...args]);
});
