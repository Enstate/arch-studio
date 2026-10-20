import { expect, test } from "bun:test";
import type { MeshPhysicalMaterial } from "three/webgpu";
import type { Plan } from "../src/plan/schema.ts";
import { MaterialLibrary } from "../src/build/materials.ts";

test.each([0, 0.04])("preserves authored floor clearcoat roughness %s", (roughness) => {
  const plan: Plan = {
    version: 1,
    name: "Polished finish",
    walls: [{ id: "wall", a: [0, 0], b: [4, 0] }],
    defaults: { floor: "polished" },
    materials: { polished: { color: "#cccccc", clearcoat: 1, clearcoatRoughness: roughness } },
    furniture: [{ id: "cabinet", type: "box", position: [2, 1], material: "polished" }],
  };
  const library = new MaterialLibrary(plan, () => undefined);
  try {
    expect((library.get("polished") as MeshPhysicalMaterial).clearcoatRoughness).toBe(roughness);
  } finally {
    library.dispose();
  }
});

test("uses the floor default only when clearcoat roughness is omitted", () => {
  const plan: Plan = {
    version: 1,
    name: "Default floor finish",
    walls: [{ id: "wall", a: [0, 0], b: [4, 0] }],
    defaults: { floor: "finish" },
    materials: { finish: { color: "#cccccc", clearcoat: 1 } },
  };
  const library = new MaterialLibrary(plan, () => undefined);
  try {
    expect((library.get("finish") as MeshPhysicalMaterial).clearcoatRoughness).toBe(0.35);
  } finally {
    library.dispose();
  }
});
