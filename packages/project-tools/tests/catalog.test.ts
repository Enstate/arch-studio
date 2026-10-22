import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { zlibSync } from "fflate";
import { MeshoptDecoder } from "meshoptimizer";
import { assetCatalog, catalogFile, catalogIndex, withLibraryLock } from "../src/catalog.ts";
import { bundleLibraryAssets } from "../src/index.ts";
import { shrinkPng } from "../src/png.ts";
import { simReadyName } from "../src/simready.ts";
import { convertUsdAsset } from "../src/usd.ts";

const write = async (file: string, contents: string | object) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
};
const temporary = async (name: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `arch-${name}-`)));

/** A box mesh in USD's Z-up space, from its minimum and maximum corner. */
function box(name: string, [x0, y0, z0]: number[], [x1, y1, z1]: number[]) {
  const points = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return `    def Mesh "${name}"
    {
        int[] faceVertexCounts = [${faces.map(() => 4).join(", ")}]
        int[] faceVertexIndices = [${faces.flat().join(", ")}]
        point3f[] points = [${points.map((p) => `(${p.join(", ")})`).join(", ")}]
    }
`;
}

/**
 * The layout SimReady's exporter writes: parts in the base layer reference prims nested in an
 * instances layer, which reference meshes nested in a geometry layer and bind their materials on
 * an `over` of the mesh with `prepend rel`. Materials carry property metadata blocks.
 */
const layers = {
  "simready_usd/payloads/base.usda": `#usda 1.0
(
    defaultPrim = "RootNode"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "RootNode"
{
    def Scope "Geometry"
    {
        def Xform "seat_obj_00" (
            instanceable = true
            prepend references = @./instances.usda@</Instances/seat_mesh_00>
        )
        {
            double3 xformOp:translate = (0, 0, 0.4)
            uniform token[] xformOpOrder = ["xformOp:translate"]
        }

        def Xform "leg_obj_00" (
            instanceable = true
            prepend references = @./instances.usda@</Instances/leg_mesh_00>
        )
        {
            double3 xformOp:translate = (0, 0, 0)
            uniform token[] xformOpOrder = ["xformOp:translate"]
        }
    }
}
`,
  "simready_usd/payloads/instances.usda": `#usda 1.0

def Scope "Instances"
{
${["seat", "leg"].map((part) => `    def Xform "${part}_mesh_00" (
        prepend references = @./geometries.usda@</Geometries/${part}_mesh_00>
    )
    {
        over "${part}_mesh_00" (
            apiSchemas = ["MaterialBindingAPI"]
        )
        {
            custom rel material:binding
            prepend rel material:binding = </Instances/${part}_mesh_00/VisualMaterials/${part === "seat" ? "red" : "blue"}>
        }

        def Scope "VisualMaterials"
        {
            def Material "${part === "seat" ? "red" : "blue"}" (
                prepend references = @./materials.usda@</Materials/${part === "seat" ? "red" : "blue"}>
            )
            {
            }
        }
    }
`).join("\n")}}
`,
  "simready_usd/payloads/geometries.usda": `#usda 1.0

def Scope "Geometries"
{
${box("seat_mesh_00", [-0.25, -0.3, 0], [0.25, 0.3, 0.1])}${box("leg_mesh_00", [-0.02, -0.02, 0], [0.02, 0.02, 0.4])}}
`,
  "simready_usd/payloads/materials.usda": `#usda 1.0

def Scope "Materials"
{
${[["red", "0.8, 0.1, 0.1"], ["blue", "0.1, 0.1, 0.8"]].map(([name, color]) => `    def Material "${name}"
    {
        token outputs:surface (
            displayGroup = "Outputs"
        )
        prepend token outputs:surface.connect = </Materials/${name}/Surface.outputs:surface>

        def Shader "Surface"
        {
            token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor = (${color})
            float inputs:roughness = 0.4
            float inputs:metallic = 0
            token outputs:surface
        }
    }
`).join("\n")}}
`,
};

test("a SimReady-style USD asset becomes one glTF part per prop part, at real size, facing +z, with its bound finishes", async () => {
  const model = await convertUsdAsset({
    root: "simready_usd/payloads/base.usda",
    layers: new Map(Object.entries(layers).map(([file, text]) => [file, new TextEncoder().encode(text)])),
    texture: async () => undefined,
  }, { turn: 90 });
  // 0.6 m wide along USD y, 0.5 m deep along x (its front), 0.5 m tall: turned so the front faces +z.
  expect(model.size).toEqual([0.6, 0.5, 0.5]);
  expect(model.triangles).toBe(24);
  await MeshoptDecoder.ready;
  const document = await new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR)).registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder }).readBinary(model.glb);
  // Each part brings only its own mesh, not every mesh of the geometry layer.
  expect(document.getRoot().listMeshes()).toHaveLength(2);
  const finishes = Object.fromEntries(document.getRoot().listMaterials().map((material) => [material.getName(), material.getBaseColorFactor().map((value) => Math.round(value * 10) / 10)]));
  expect(finishes).toEqual({ red: [0.8, 0.1, 0.1, 1], blue: [0.1, 0.1, 0.8, 1] });
});

/** A PNG of solid colour, written the plain way: unfiltered rows, one IDAT. */
function solidPng(width: number, height: number, rgb: [number, number, number]) {
  const rows = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  const chunk = (kind: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set([...kind].map((c) => c.charCodeAt(0)), 4);
    out.set(body, 8);
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlibSync(rows)), chunk("IEND", new Uint8Array())]);
}

test("a large PNG shrinks to the longest side asked for and keeps its colour; a small one stays as it is", () => {
  const large = solidPng(1024, 512, [200, 120, 40]);
  const small = shrinkPng(large, 256)!;
  const view = new DataView(small.buffer, small.byteOffset);
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([256, 128]);
  // Shrinking the result again changes nothing, so it reads back as a valid PNG of that size.
  expect(shrinkPng(small, 256)).toBe(small);
  expect(shrinkPng(new Uint8Array([1, 2, 3]), 256)).toBeNull();
});

test("the catalog reads the store's imports before the shared library and serves only files its indexes hold", async () => {
  const root = await temporary("catalog");
  try {
    const store = path.join(root, "library"), shared = path.join(root, "shared");
    await write(path.join(store, "index.json"), { version: 2, textures: {}, models: { simready_sofa_a01: { size: [1.5, 0.7, 0.7], name: "Sofa A01", category: "seating", thumbnail: "thumbs/simready_sofa_a01.png", credit: "- Sofa A01 (model), NVIDIA SimReady, CC BY 4.0", source: "simready" } }, hdris: {} });
    await write(path.join(store, "models/simready_sofa_a01.glb"), "sofa");
    await write(path.join(store, "thumbs/simready_sofa_a01.png"), "png");
    await write(path.join(shared, "index.json"), { version: 3, textures: { oak: { size: [1, 1], maps: ["color"], res: [512] } }, models: { modern_arm_chair_01: { size: [0.8, 0.8, 0.9] }, simready_sofa_a01: { size: [9, 9, 9] } }, hdris: { garden: { sun: [0, 1, 0] } } });
    await write(path.join(shared, "models/modern_arm_chair_01.glb"), "chair");
    await write(path.join(shared, "secret.json"), "{}");
    const folders = [store, shared];
    const { models, textures } = await assetCatalog(folders);
    expect(models.map((model) => [model.id, model.name, model.category, model.source])).toEqual([
      ["simready_sofa_a01", "Sofa A01", "seating", "simready"],
      ["modern_arm_chair_01", "Modern arm chair", "seating", "library"],
    ]);
    expect(models[0]!.size).toEqual([1.5, 0.7, 0.7]);
    expect(textures.map((texture) => texture.id)).toEqual(["oak"]);
    const index = await catalogIndex(folders);
    expect(index.version).toBe(3);
    expect(Object.keys(index.models).sort()).toEqual(["modern_arm_chair_01", "simready_sofa_a01"]);
    expect((index.models.simready_sofa_a01 as { size: number[] }).size).toEqual([1.5, 0.7, 0.7]);
    expect(await catalogFile("models/simready_sofa_a01.glb", folders)).toBe(path.join(store, "models/simready_sofa_a01.glb"));
    expect(await catalogFile("models/modern_arm_chair_01.glb", folders)).toBe(path.join(shared, "models/modern_arm_chair_01.glb"));
    expect(await catalogFile("thumbs/simready_sofa_a01.png", folders)).toBe(path.join(store, "thumbs/simready_sofa_a01.png"));
    for (const refused of ["secret.json", "models/unknown.glb", "models/../secret.json", "thumbs/.hidden", ""]) expect(await catalogFile(refused, folders)).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundling takes each asset from the first library that holds it and keeps its credit with the project", async () => {
  const root = await temporary("bundle");
  try {
    await write(path.join(root, "store/index.json"), { version: 2, textures: {}, models: { simready_lamp_a01: { size: [0.2, 0.2, 0.4], credit: "- Lamp A01 (model), NVIDIA SimReady, CC BY 4.0, https://example.test/lamp" } }, hdris: {} });
    await write(path.join(root, "store/models/simready_lamp_a01.glb"), "lamp");
    await write(path.join(root, "shared/index.json"), { version: 2, textures: { oak: { size: [1, 1], maps: ["color"], res: [512] } }, models: { side_table_01: { size: [0.5, 0.5, 0.5] } }, hdris: {} });
    await write(path.join(root, "shared/models/side_table_01.glb"), "table");
    await write(path.join(root, "shared/textures/oak/512/color.webp"), "oak");
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const from = [{ root: path.join(root, "store"), library: "" }, { root: path.join(root, "shared"), library: "" }];
    const to = { root: project, library: "assets/library" };
    await bundleLibraryAssets(from, to, { models: ["simready_lamp_a01", "side_table_01"], textures: ["oak"] });
    // Bundling again adds no second credit line.
    await bundleLibraryAssets(from, to, { models: ["simready_lamp_a01"], textures: [] });
    expect(await fs.readFile(path.join(project, "assets/library/models/simready_lamp_a01.glb"), "utf8")).toBe("lamp");
    expect(await fs.readFile(path.join(project, "assets/library/models/side_table_01.glb"), "utf8")).toBe("table");
    expect(await fs.readFile(path.join(project, "assets/library/textures/oak/512/color.webp"), "utf8")).toBe("oak");
    const index = JSON.parse(await fs.readFile(path.join(project, "assets/library/index.json"), "utf8"));
    expect(Object.keys(index.models).sort()).toEqual(["side_table_01", "simready_lamp_a01"]);
    const credits = await fs.readFile(path.join(project, "assets/library/CREDITS.md"), "utf8");
    expect(credits.match(/Lamp A01/g)).toHaveLength(1);
    await expect(bundleLibraryAssets(from, to, { models: ["missing_model"], textures: [] })).rejects.toThrow("missing_model");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SimReady asset IDs read as names", () => {
  expect(simReadyName("sofa_soft_b01")).toBe("Sofa soft B01");
  expect(simReadyName("appliance_handDryer_automatic_a01")).toBe("Appliance hand Dryer automatic A01");
});

test("writers holding the library lock never interleave, and a stale lock from a dead process is taken over", async () => {
  const library = await temporary("lock");
  try {
    const log: string[] = [];
    const writer = (name: string) => withLibraryLock(library, async () => {
      log.push(`${name} in`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      log.push(`${name} out`);
    });
    await Promise.all([writer("a"), writer("b"), writer("c")]);
    for (let i = 0; i < log.length; i += 2) expect(log[i + 1]).toBe(log[i]!.replace(" in", " out"));
    expect(await fs.readdir(library)).toEqual([]);
    const lock = path.join(library, ".index.lock");
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 11 * 60_000);
    await fs.utimes(lock, old, old);
    expect(await withLibraryLock(library, async () => "taken over")).toBe("taken over");
  } finally {
    await fs.rm(library, { recursive: true, force: true });
  }
});
