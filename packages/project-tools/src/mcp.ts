import { promises as fs } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PIECE_CATEGORIES, FURNITURE_CATEGORY, type PieceCategory } from "@arch/viewer/plan/categories";
import { FURNITURE_DEFAULT_SIZE } from "@arch/viewer/plan/furnitureSizes";
import { polygonArea, polygonCentroid, roomAt } from "@arch/viewer/plan/geom";
import { levelOf, levelPlan, levels } from "@arch/viewer/plan/levels";
import { defaultDesignOption, shownInOption } from "@arch/viewer/plan/options";
import { nearestFreeSpot, placementProblem, snapPlacement } from "@arch/viewer/plan/placement";
import type { Furniture, FurnitureType, Plan, Vec2 } from "@arch/viewer/plan/schema";
import { z } from "zod";
import { assetCatalog, catalogFolders, importSimReady, type CatalogModel } from "./catalog.ts";
import { bundleLibraryAssets } from "./index.ts";
import { searchSimReady } from "./simready.ts";

/**
 * Arch's MCP server: the asset catalog and the furnished plan of one project folder, for agents.
 * It reads the project's last build (`outputs/artifact/plan.json`, hand edits included) and never
 * edits source; agents change the plan in source as usual and Studio builds after the turn.
 */

const INSTRUCTIONS = `Arch tools for furnishing this project.
- search_catalog finds models in the local library (CC0 Poly Haven and imported assets) and in NVIDIA SimReady (CC BY 4.0, searched online).
- import_simready_asset converts a SimReady asset into the local catalog. add_assets_to_project then copies catalog models into this project's assets/library with their index entries and credits. Place them in the plan as model "@lib/models/<id>.glb"; without a size a model keeps its real size.
- describe_rooms and list_furniture read the last build. find_spot and check_placement test a piece against walls, door swings, windows and other furniture the way Studio's hand editor does.
Positions are plan metres: x right, y down; rotation is degrees clockwise, 0 faces +y.`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
interface Tool { name: string; title: string; description: string; annotations?: Record<string, boolean>; input: z.ZodObject; run(args: unknown): Promise<ToolResult> }
const json = (value: unknown): ToolResult => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });
const round = (value: number) => Math.round(value * 1000) / 1000;
const vec2 = z.tuple([z.number(), z.number()]);
const furnitureTypes = Object.keys(FURNITURE_DEFAULT_SIZE) as [FurnitureType, ...FurnitureType[]];

/** A piece to place: a library model or a built-in type, optionally sized and turned. */
const pieceInput = z.object({
  model: z.string().regex(/^@lib\/models\/[A-Za-z0-9_-]+\.glb$/).optional().describe('Library model, "@lib/models/<id>.glb".'),
  type: z.enum(furnitureTypes).optional().describe("Built-in piece type; defaults to box for a model."),
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional().describe("[width, depth, height] in metres; a model keeps its real size without it."),
  rotation: z.number().optional().describe("Degrees clockwise; 0 faces +y."),
  elevation: z.number().optional().describe("Height of the bottom above the floor, for wall cabinets."),
});

export interface ArchMcpOptions {
  /** The project folder an agent works in. */
  project: string;
  /** Catalog folders, first wins; defaults to the store's imports and the shared library. */
  catalog?: string[];
}

/** The MCP server for one project folder, before it is connected to a transport. */
export function archMcpServer({ project, catalog = catalogFolders() }: ArchMcpOptions) {
  const server = new Server({ name: "arch", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const tools: Tool[] = [];
  /** Registers a tool whose arguments `input` checks; the client sees its JSON Schema. */
  const tool = <Shape extends z.ZodRawShape>(name: string, config: { title: string; description: string; input: Shape; annotations?: Record<string, boolean> }, run: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>) => {
    tools.push({ name, title: config.title, description: config.description, annotations: config.annotations, input: z.object(config.input).strict(), run: run as Tool["run"] });
  };
  const projectLibrary = path.join(project, "assets/library");

  async function builtPlan(): Promise<Plan> {
    try {
      return JSON.parse(await fs.readFile(path.join(project, "outputs/artifact/plan.json"), "utf8")) as Plan;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("This project has no build yet. Furniture tools read the last build; Studio builds after your turn.");
      throw error;
    }
  }
  async function models(): Promise<Map<string, CatalogModel>> {
    const { models: found } = await assetCatalog([projectLibrary, ...catalog]);
    return new Map(found.map((model) => [model.id, model]));
  }
  const modelId = (model?: string) => model?.match(/^@lib\/models\/(.+)\.glb$/)?.[1];
  /** A piece's [width, depth, height]: its own, its library model's, or its type's. */
  const sizer = (known: Map<string, CatalogModel>) => (f: Pick<Furniture, "size" | "model" | "type">): [number, number, number] =>
    f.size ?? known.get(modelId(f.model) ?? "")?.size ?? FURNITURE_DEFAULT_SIZE[f.type];
  const lookOf = (plan: Plan, option?: string) => option ?? defaultDesignOption(plan)?.id ?? null;
  const roomOf = (plan: Plan, f: Furniture) => f.room ?? roomAt(levelPlan(plan, levelOf(plan, f.level)), f.position)?.id ?? null;

  tool("search_catalog", {
    title: "Search the asset catalog",
    description: "Models for furnishing: the local library first, then NVIDIA SimReady online. Words match names, labels and categories.",
    input: {
      query: z.string().max(200).default("").describe('What to look for, such as "armchair" or "bedside lamp".'),
      category: z.enum(PIECE_CATEGORIES).optional(),
      simready: z.boolean().default(true).describe("Also search NVIDIA SimReady (needs the network)."),
      limit: z.number().int().min(1).max(50).default(12),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, category, simready, limit }) => {
    try {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const known = await models();
      const local = [...known.values()]
        .filter((model) => (!category || model.category === category) && words.every((word) => `${model.id} ${model.name} ${model.label ?? ""} ${model.category}`.toLowerCase().includes(word)))
        .slice(0, limit)
        .map((model) => ({ model: `@lib/models/${model.id}.glb`, name: model.name, category: model.category, size: model.size, source: model.source, ...(model.credit && { credit: model.credit }) }));
      let online: unknown[] | { error: string } = [];
      if (simready) {
        try {
          const { assets } = await searchSimReady([query, category && category !== "other" ? category : ""].filter(Boolean).join(" "), { limit });
          online = assets.filter((asset) => !category || asset.category === category).map((asset) => ({ asset: asset.id, name: asset.name, label: asset.label, category: asset.category, size: asset.size, license: asset.license, imported: known.has(`simready_${asset.id}`) }));
        } catch (error) {
          online = { error: `SimReady search is unavailable: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      return json({ library: local, simready: online });
    } catch (error) {
      return failure(error);
    }
  });

  tool("import_simready_asset", {
    title: "Import a SimReady asset",
    description: "Downloads an NVIDIA SimReady asset by its ID from search_catalog and converts it into the local catalog (glTF, real size, front facing +y). Takes seconds to a minute.",
    input: { asset: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/).describe('SimReady asset ID, such as "sofa_soft_b01".') },
    annotations: { openWorldHint: true },
  }, async ({ asset }) => {
    try {
      const model = await importSimReady(asset);
      return json({ model: `@lib/models/${model.id}.glb`, name: model.name, category: model.category, size: model.size, credit: model.credit, next: "add_assets_to_project before the plan uses it." });
    } catch (error) {
      return failure(error);
    }
  });

  tool("add_assets_to_project", {
    title: "Add catalog assets to this project",
    description: "Copies catalog models and textures into this project's assets/library, with their index entries and CREDITS.md lines, so the build bundles them.",
    input: {
      models: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).max(40).default([]).describe('Library IDs, the <id> of "@lib/models/<id>.glb".'),
      textures: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).max(40).default([]).describe("Library texture set IDs, for a material's pbr."),
    },
  }, async ({ models: ids, textures }) => {
    try {
      const sources = await Promise.all(catalog.map(async (folder) => ({ root: await fs.realpath(folder).catch(() => folder), library: "" })));
      await bundleLibraryAssets(sources, { root: project, library: "assets/library" }, { models: ids, textures });
      return json({ added: { models: ids.map((id) => `@lib/models/${id}.glb`), textures }, library: "assets/library", note: "Keep assets/library/CREDITS.md with the delivery." });
    } catch (error) {
      return failure(error);
    }
  });

  tool("describe_rooms", {
    title: "Describe rooms",
    description: "Storeys and rooms of the last build: IDs, names, areas, centres and how many pieces each holds.",
    input: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const plan = await builtPlan();
      const pieces = plan.furniture ?? [];
      return json({
        levels: plan.levels?.length ? levels(plan).map((level) => ({ id: level.id, name: level.name, elevation: level.elevation })) : [],
        designOptions: (plan.designOptions ?? []).map((option) => ({ id: option.id, name: option.name, default: option === defaultDesignOption(plan) })),
        rooms: (plan.rooms ?? []).map((room) => ({
          id: room.id,
          name: room.name,
          ...(room.level && { level: room.level }),
          area: round(polygonArea(room.polygon)),
          centre: polygonCentroid(room.polygon).map(round),
          pieces: pieces.filter((f) => !f.roof && roomOf(plan, f) === room.id).length,
        })),
      });
    } catch (error) {
      return failure(error);
    }
  });

  tool("list_furniture", {
    title: "List furniture",
    description: "Pieces of the last build, hand edits included, with their room, size and whether Studio's hand editor may move them.",
    input: {
      room: z.string().optional().describe("Only this room ID."),
      level: z.string().optional().describe("Only this storey ID."),
      category: z.enum(PIECE_CATEGORIES).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ room, level, category }) => {
    try {
      const plan = await builtPlan();
      const known = await models();
      const sizeOf = sizer(known);
      const pieces = (plan.furniture ?? []).filter((f) => !f.roof).map((f) => {
        const model = known.get(modelId(f.model) ?? "");
        return {
          id: f.id,
          type: f.type,
          ...(f.model && { model: f.model }),
          name: model?.name ?? f.type,
          category: (model?.category ?? FURNITURE_CATEGORY[f.type]) as PieceCategory,
          room: roomOf(plan, f),
          level: levelOf(plan, f.level).id,
          position: f.position,
          rotation: f.rotation ?? 0,
          size: sizeOf(f),
          ...(f.designOptions && { designOptions: f.designOptions }),
          fixed: f.type === "stairs" || f.fixture === true,
        };
      });
      return json(pieces.filter((f) => (!room || f.room === room) && (!level || f.level === level) && (!category || f.category === category)));
    } catch (error) {
      return failure(error);
    }
  });

  /** A candidate piece on a storey, with the sizes it and the others are measured by. */
  async function candidate(input: z.infer<typeof pieceInput>, level?: string) {
    const plan = await builtPlan();
    const sizeOf = sizer(await models());
    const piece: Furniture = { id: "candidate", type: input.type ?? "box", position: [0, 0], ...(input.model && { model: input.model }), ...(input.size && { size: input.size }), ...(level && { level }), ...(input.elevation !== undefined && { elevation: input.elevation }) };
    const storey = levelPlan(plan, levelOf(plan, level));
    return { plan, storey, piece, size: sizeOf(piece), sizeOf, rotation: input.rotation ?? 0 };
  }

  tool("find_spot", {
    title: "Find a free spot",
    description: "The nearest position to a room's centre (or to `near`) where a piece fits, snapped to 10 cm and flush to a wall within 15 cm, clear of walls, door swings, windows and furniture.",
    input: {
      piece: pieceInput,
      room: z.string().optional().describe("Room ID to place in; its storey and centre are used."),
      near: vec2.optional().describe("Plan point to start from instead of the room centre."),
      level: z.string().optional().describe("Storey ID when no room is given."),
      designOption: z.string().optional().describe("Look whose furniture counts; defaults to the default option."),
    },
    annotations: { readOnlyHint: true },
  }, async ({ piece: input, room, near, level, designOption }) => {
    try {
      const plan = await builtPlan();
      const target = room ? plan.rooms?.find((r) => r.id === room) : undefined;
      if (room && !target) throw new Error(`No room ${room}. describe_rooms lists them.`);
      const { storey, piece, size, sizeOf, rotation } = await candidate(input, target?.level ?? level);
      const start: Vec2 = near ?? (target ? polygonCentroid(target.polygon) : null) ?? (() => { throw new Error("Give a room or a near point."); })();
      const look = lookOf(plan, designOption);
      const at = nearestFreeSpot(start, (p) => snapPlacement(storey, p, rotation, size), (p) => !placementProblem(storey, { id: piece.id, type: piece.type, position: p, rotation, size, elevation: piece.elevation }, sizeOf, look));
      if (!at) return json({ found: false, reason: "No free spot within 1.5 m. Try another rotation, a smaller size, or move something." });
      const landed = roomAt(storey, at);
      return json({ found: true, position: at, rotation, size, room: landed?.id ?? null, ...(piece.level && { level: piece.level }) });
    } catch (error) {
      return failure(error);
    }
  });

  tool("check_placement", {
    title: "Check a placement",
    description: "Whether a piece can stand at a position: what it would run into (a wall, a door swing or passage, a window above its sill, or another piece) and which room it lands in.",
    input: {
      piece: pieceInput,
      position: vec2,
      level: z.string().optional(),
      id: z.string().optional().describe("ID of an existing piece being moved, so it does not collide with itself."),
      designOption: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ piece: input, position, level, id, designOption }) => {
    try {
      const { plan, storey, piece, size, sizeOf, rotation } = await candidate(input, level);
      const look = lookOf(plan, designOption);
      const others = { ...storey, furniture: (storey.furniture ?? []).filter((f) => f.id !== id && shownInOption(f, look)) };
      const problem = placementProblem(others, { id: id ?? piece.id, type: piece.type, position, rotation, size, elevation: piece.elevation }, sizeOf, look);
      return json({ fits: !problem, ...(problem && { blockedBy: problem }), room: roomAt(storey, position)?.id ?? null, size });
    } catch (error) {
      return failure(error);
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((item) => ({ name: item.name, title: item.title, description: item.description, inputSchema: z.toJSONSchema(item.input, { io: "input" }) as { type: "object" }, ...(item.annotations && { annotations: item.annotations }) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const item = tools.find((candidate) => candidate.name === request.params.name);
    if (!item) return failure(`No tool ${request.params.name}.`);
    const args = item.input.safeParse(request.params.arguments ?? {});
    if (!args.success) return failure(`Invalid arguments: ${z.prettifyError(args.error)}`);
    return item.run(args.data);
  });
  return server;
}

/** Serves the MCP over stdio until the client closes it. `args`: [--project <folder>]. */
export async function serveArchMcp(args: string[]) {
  const flag = args.indexOf("--project");
  const project = path.resolve(flag >= 0 && args[flag + 1] ? args[flag + 1]! : process.cwd());
  if (!(await fs.stat(project)).isDirectory()) throw new Error(`${project} is not a folder.`);
  await archMcpServer({ project }).connect(new StdioServerTransport());
}

/**
 * Answers one streamable HTTP MCP request for a project, statelessly: a fresh server per POST,
 * with JSON responses, and 405 for the event stream. The caller decides who may reach the project.
 */
export async function archMcpResponse(request: Request, options: ArchMcpOptions): Promise<Response> {
  // Stateless: no event stream to open and no session to end.
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = archMcpServer(options);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
