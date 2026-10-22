import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantRoundMcp, mcpResponse } from "./mcp.server";

const rpc = (url: string, body: object, headers: Record<string, string> = {}) =>
  mcpResponse(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers }, body: JSON.stringify(body) }), url.split("/").pop()!);

test("a round's MCP URL reaches only its project, only from loopback, and stops when the round ends", async () => {
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-mcp-route-")));
  try {
    await fs.mkdir(path.join(project, "outputs/artifact"), { recursive: true });
    await fs.writeFile(path.join(project, "outputs/artifact/plan.json"), JSON.stringify({ version: 1, name: "Room", walls: [], rooms: [{ id: "living", name: "Living", polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] }] }));
    const grant = grantRoundMcp("http://127.0.0.1:3101", project);
    const rooms = await rpc(grant.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "describe_rooms", arguments: {} } });
    expect(rooms.status).toBe(200);
    expect(JSON.parse(JSON.parse(await rooms.text()).result.content[0].text).rooms[0].id).toBe("living");
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    expect((await rpc(grant.url.replace(/[a-f0-9]{64}$/, "a".repeat(64)), list)).status).toBe(404);
    expect((await rpc(grant.url, list, { origin: "http://evil.test" })).status).toBe(404);
    expect((await rpc(grant.url.replace("127.0.0.1", "studio.example"), list)).status).toBe(404);
    grant.revoke();
    expect((await rpc(grant.url, list)).status).toBe(404);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
