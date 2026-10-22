import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Plan } from "@arch/viewer/plan/schema";
import { archMcpResponse } from "../src/mcp.ts";

const write = async (file: string, contents: object) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(contents));
};

/** Two rooms side by side, 4 m and 3 m wide and 3 m deep, with a door between them. */
const plan: Plan = {
  version: 1,
  name: "Two rooms",
  walls: [
    { id: "north", a: [0, 0], b: [7, 0], exterior: true },
    { id: "east", a: [7, 0], b: [7, 3], exterior: true },
    { id: "south", a: [7, 3], b: [0, 3], exterior: true },
    { id: "west", a: [0, 3], b: [0, 0], exterior: true },
    { id: "middle", a: [4, 0], b: [4, 3] },
  ],
  openings: [{ id: "door", wall: "middle", type: "door", offset: 1.5, width: 0.9 }],
  rooms: [
    { id: "living", name: "Living", polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] },
    { id: "study", name: "Study", polygon: [[4, 0], [7, 0], [7, 3], [4, 3]] },
  ],
  furniture: [
    { id: "sofa", type: "sofa", position: [2, 2.4] },
    { id: "lamp", type: "box", position: [5.5, 0.4], model: "@lib/models/simready_lamp_a01.glb" },
  ],
};

async function connect(project: string, library: string) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/api/mcp/test"), {
    fetch: (input, init) => archMcpResponse(new Request(input, init), { project, catalog: [library] }),
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text);
  };
  return { client, call };
}

test("the MCP lists rooms and furniture of the last build and places pieces clear of walls, doors and furniture", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-mcp-")));
  try {
    const project = path.join(root, "project"), library = path.join(root, "library");
    await write(path.join(project, "outputs/artifact/plan.json"), plan);
    await write(path.join(library, "index.json"), { version: 2, textures: {}, models: { simready_lamp_a01: { size: [0.2, 0.2, 0.4], name: "Lamp A01", category: "lighting", source: "simready", credit: "- Lamp A01 (model), NVIDIA SimReady, CC BY 4.0" }, simready_sofa_a01: { size: [1.5, 0.7, 0.7], name: "Sofa A01", category: "seating", source: "simready" } }, hdris: {} });
    await fs.mkdir(path.join(library, "models"));
    await fs.writeFile(path.join(library, "models/simready_sofa_a01.glb"), "sofa");
    const { client, call } = await connect(project, library);

    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual(["add_assets_to_project", "check_placement", "describe_rooms", "find_spot", "import_simready_asset", "list_furniture", "search_catalog"]);

    const rooms = await call("describe_rooms");
    expect(rooms.rooms.map((room: { id: string; area: number; pieces: number }) => [room.id, room.area, room.pieces])).toEqual([["living", 12, 1], ["study", 9, 1]]);

    const study = await call("list_furniture", { room: "study" });
    expect(study).toHaveLength(1);
    expect(study[0]).toMatchObject({ id: "lamp", name: "Lamp A01", category: "lighting", room: "study", size: [0.2, 0.2, 0.4] });
    expect(await call("list_furniture", { category: "seating" })).toMatchObject([{ id: "sofa", room: "living" }]);

    const found = await call("search_catalog", { query: "sofa", simready: false });
    expect(found.library).toEqual([{ model: "@lib/models/simready_sofa_a01.glb", name: "Sofa A01", category: "seating", size: [1.5, 0.7, 0.7], source: "simready" }]);

    // The sofa model fits in the study and lands inside it.
    const spot = await call("find_spot", { room: "study", piece: { model: "@lib/models/simready_sofa_a01.glb" } });
    expect(spot).toMatchObject({ found: true, room: "study", size: [1.5, 0.7, 0.7] });
    expect((await call("check_placement", { piece: { model: "@lib/models/simready_sofa_a01.glb" }, position: spot.position })).fits).toBe(true);
    // Standing in the middle wall, or on the existing sofa, it does not.
    expect(await call("check_placement", { piece: { model: "@lib/models/simready_sofa_a01.glb" }, position: [4, 0.6] })).toMatchObject({ fits: false, blockedBy: { kind: "wall", id: "middle" } });
    expect(await call("check_placement", { piece: { type: "armchair" }, position: [2, 2.4] })).toMatchObject({ fits: false, blockedBy: { kind: "furniture", id: "sofa" } });
    // Moving the sofa itself does not collide with where it stands now, but its end may not reach into the door's swing.
    expect((await call("check_placement", { piece: { type: "sofa" }, position: [1.8, 2.3], id: "sofa" })).fits).toBe(true);
    expect(await call("check_placement", { piece: { type: "sofa" }, position: [2, 2.3], id: "sofa" })).toMatchObject({ fits: false, blockedBy: { kind: "door", id: "door" } });

    await call("add_assets_to_project", { models: ["simready_sofa_a01"] });
    expect(await fs.readFile(path.join(project, "assets/library/models/simready_sofa_a01.glb"), "utf8")).toBe("sofa");

    await expect(call("find_spot", { room: "kitchen", piece: { type: "chair" } })).rejects.toThrow("No room kitchen");
    await client.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("furniture tools say so when the project has no build yet", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-mcp-")));
  try {
    const { client, call } = await connect(root, root);
    await expect(call("describe_rooms")).rejects.toThrow("no build yet");
    await client.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
