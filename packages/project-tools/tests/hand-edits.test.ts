import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plan } from "@arch/viewer/plan/schema";
import type { PlanEdits } from "@arch/viewer/plan/edits";
import { applyHandEdits, saveHandEdits } from "../src/index.ts";

const plan: Plan = {
  version: 1,
  name: "Hand edits",
  walls: [{ id: "north", a: [0, 0], b: [4, 0] }, { id: "east", a: [4, 0], b: [4, 3] }],
  rooms: [{ id: "living", name: "Living", polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
  furniture: [{ id: "sofa", type: "sofa", position: [2, 2] }],
};
const edits: PlanEdits = {
  version: 1,
  furniture: { sofa: { position: [1, 1], rotation: 90 }, "old-chair": { removed: true } },
  added: [{ id: "lounge-chair-2", type: "box", position: [3, 2], model: "@lib/models/lounge_chair.glb", room: "living" }],
  surfaces: { "floor:living": "paint-1", "wall:living:north": "paint-1", "outside:east": "paint-1" },
  materials: { "paint-1": { color: "#c8b8a0", pbr: "oak" } },
};
const write = async (file: string, contents: string | object) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
};

test("a build lays hand edits over the generated plan, lists dropped ones and bundles their library assets", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-hand-edits-")));
  try {
    expect(await applyHandEdits(directory)).toBeNull();
    await write(path.join(directory, "outputs/artifact/plan.json"), plan);
    await write(path.join(directory, "source/edits.json"), edits);
    await write(path.join(directory, "assets/library/index.json"), { version: 2, textures: { oak: { size: [1, 1], maps: ["color", "normal"], res: [512] } }, models: { lounge_chair: { size: [0.8, 0.8, 0.9] } }, hdris: {} });
    await write(path.join(directory, "assets/library/models/lounge_chair.glb"), "glb");
    await write(path.join(directory, "assets/library/textures/oak/512/color.webp"), "color");
    await write(path.join(directory, "assets/library/textures/oak/512/normal.webp"), "normal");
    // The generator bundled a library of its own, which keeps its entries.
    await write(path.join(directory, "outputs/artifact/library/index.json"), { version: 2, textures: {}, models: { side_table: { size: [0.5, 0.5, 0.5] } }, hdris: {} });

    expect(await applyHandEdits(directory)).toEqual({ dropped: ["furniture old-chair: removed by hand, no longer in the plan"] });
    const merged = JSON.parse(await fs.readFile(path.join(directory, "outputs/artifact/plan.json"), "utf8")) as Plan;
    expect(merged.furniture).toEqual([{ id: "sofa", type: "sofa", position: [1, 1], rotation: 90 }, edits.added![0]!]);
    expect(merged.rooms![0]!.floor).toBe("paint-1");
    expect(merged.rooms![0]!.wallFinishes).toEqual({ north: "paint-1" });
    expect(merged.walls[1]!.outsideFinish).toBe("paint-1");
    expect(merged.materials).toEqual(edits.materials);
    expect(JSON.parse(await fs.readFile(path.join(directory, "outputs/artifact/hand-edits.json"), "utf8"))).toEqual({ dropped: ["furniture old-chair: removed by hand, no longer in the plan"] });
    expect(await fs.readFile(path.join(directory, "outputs/artifact/library/models/lounge_chair.glb"), "utf8")).toBe("glb");
    expect(await fs.readFile(path.join(directory, "outputs/artifact/library/textures/oak/512/normal.webp"), "utf8")).toBe("normal");
    const index = JSON.parse(await fs.readFile(path.join(directory, "outputs/artifact/library/index.json"), "utf8"));
    expect(Object.keys(index.models).sort()).toEqual(["lounge_chair", "side_table"]);
    expect(index.textures.oak.res).toEqual([512]);

    await write(path.join(directory, "source/edits.json"), { version: 1, surfaces: { "floor:living": 3 } });
    await expect(applyHandEdits(directory)).rejects.toThrow("source/edits.json is not valid hand edits");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("saving hand edits copies the library assets they use into the project, creating its index", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arch-hand-edits-")));
  try {
    const library = path.join(temporary, "library"), directory = path.join(temporary, "project");
    await write(path.join(library, "index.json"), { version: 2, textures: { oak: { size: [1, 1], maps: ["color"], res: [512, 1024] } }, models: { lounge_chair: { size: [0.8, 0.8, 0.9] }, unused: {} }, hdris: {} });
    await write(path.join(library, "models/lounge_chair.glb"), "glb");
    await write(path.join(library, "textures/oak/512/color.webp"), "512");
    await write(path.join(library, "textures/oak/1024/color.webp"), "1024");
    await fs.mkdir(directory);

    await saveHandEdits(directory, edits, library);
    expect(JSON.parse(await fs.readFile(path.join(directory, "source/edits.json"), "utf8"))).toEqual(edits);
    expect(await fs.readFile(path.join(directory, "assets/library/textures/oak/1024/color.webp"), "utf8")).toBe("1024");
    const index = JSON.parse(await fs.readFile(path.join(directory, "assets/library/index.json"), "utf8"));
    expect(index).toEqual({ version: 2, textures: { oak: { size: [1, 1], maps: ["color"], res: [512, 1024] } }, models: { lounge_chair: { size: [0.8, 0.8, 0.9] } }, hdris: {} });

    await saveHandEdits(directory, { version: 1 }, library);
    expect(JSON.parse(await fs.readFile(path.join(directory, "source/edits.json"), "utf8"))).toEqual({ version: 1 });
    expect(await applyHandEdits(directory)).toBeNull();
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
