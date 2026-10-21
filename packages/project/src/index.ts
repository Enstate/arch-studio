import { z } from "zod";

export { projectIntakeSchema, type ProjectIntakePlan } from "./intake.ts";
export * from "./history.ts";

export const projectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const relativeProjectPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== ".." && part !== "." && part.length > 0),
    "Use a relative project path without traversal segments.",
  );
export const cameraViewSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    label: z.string().min(1).max(160),
    piece: z.string().min(1).max(80),
  })
  .strict();
export const projectAssumptionSchema = z
  .object({
    id: projectId,
    description: z.string().min(1).max(2000),
    status: z.enum(["unconfirmed", "confirmed"]),
  })
  .strict();
const legacyProjectManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: projectId,
    name: z.string().min(1).max(160),
    client: z
      .object({ id: projectId, name: z.string().min(1).max(160) })
      .strict(),
    description: z.string().max(4000),
    entry: relativeProjectPath,
    runtime: z
      .object({
        name: z.literal("three"),
        version: z.string().min(1),
        templateVersion: z.string().min(1),
      })
      .strict(),
    views: z.array(cameraViewSchema).max(100),
    assumptions: z.array(projectAssumptionSchema).max(100),
    references: z
      .array(
        z
          .object({
            path: relativeProjectPath,
            label: z.string().min(1).max(160),
            kind: z.enum(["floorplan", "moodboard", "other"]),
          })
          .strict(),
      )
      .max(100),
    artifacts: z
      .array(
        z
          .object({
            id: projectId,
            kind: z.enum(["still", "video", "poster"]),
            path: relativeProjectPath,
            label: z.string().min(1).max(160),
            viewId: z.string().max(80).nullable(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();
export const viewerRuntimeSchema = z.object({ name: z.literal("arch-viewer"), version: z.literal("0.1.0"), threeVersion: z.literal("0.186.1") }).strict();
export const viewerProjectManifestSchema = legacyProjectManifestSchema.extend({ schemaVersion: z.literal(2), runtime: viewerRuntimeSchema });
export const projectManifestSchema = z.discriminatedUnion("schemaVersion", [legacyProjectManifestSchema, viewerProjectManifestSchema]);
export const artifactManifestSchema = z.object({
 schemaVersion: z.literal(1), projectId, runtime: viewerRuntimeSchema, runtimeHash: z.string().regex(/^[a-f0-9]{64}$/),
 sources: z.array(z.object({path: relativeProjectPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative()}).strict()).min(1),
 plan: relativeProjectPath,
 files: z.array(z.object({path: relativeProjectPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative()}).strict()),
 cameras: z.array(z.object({id: projectId, position: z.tuple([z.number(),z.number(),z.number()]), target: z.tuple([z.number(),z.number(),z.number()])}).strict()),
 outputs: z.array(z.object({kind:z.enum(["still","video"]),path:relativeProjectPath}).strict())
}).strict();
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export const continuationBriefSchema = z
  .object({
    goal: z.string().min(1).max(8000),
    driver: z.string().min(1).max(160),
    decisions: z.array(z.string().min(1).max(4000)).max(100),
    unresolved: z.array(z.string().min(1).max(4000)).max(100),
    nextAction: z.string().min(1).max(8000),
    instructionVersion: z.string().min(1).max(160),
  })
  .strict();
export const checkpointFileSchema = z
  .object({
    path: relativeProjectPath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict();
export const checkpointManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    projectId,
    parentId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    createdAt: z.string().datetime(),
    project: projectManifestSchema,
    brief: continuationBriefSchema,
    files: z.array(checkpointFileSchema),
  })
  .strict();
export const reviewNoteSchema = z
  .object({
    id: z.string().min(1),
    projectId,
    checkpointId: z.string().regex(/^[a-f0-9]{64}$/),
    viewId: z.string().max(80).nullable(),
    author: z.string().min(1).max(160),
    body: z.string().min(1).max(8000),
    createdAt: z.string().datetime(),
  })
  .strict();
export const reviewStageSchema = z.enum([
  "draft",
  "ready_for_review",
  "internally_accepted",
  "customer_accepted",
  "published",
]);
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type ContinuationBrief = z.infer<typeof continuationBriefSchema>;
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
export type ReviewStage = z.infer<typeof reviewStageSchema>;
export type StudioProject = {
  manifest: ProjectManifest;
  directory: string;
  updatedAt: string;
  checkpointId: string | null;
  stage: ReviewStage;
};
export type ProjectInspection = {
  project: StudioProject;
  checkpoints: CheckpointManifest[];
  notes: ReviewNote[];
};
export type PreviewSession = { url: string; projectId: string };

/** Older artifact runtimes each reviewed viewer renders. Plan, geometry, asset and runtime contracts are unchanged. */
const rendersOlder: Record<string, string[]> = {
  // Storeys stack with levels, stairs climb tread by tread, the viewer shows one floor at a time, the dollhouse gains free look, plans can supply sloped ceilings and roofs, design options switch in place, an editable viewer moves pieces and paints wall faces by hand (rooms gain wallFinishes, walls outsideFinish), and stats report the scene's meshes, triangles and materials. Plans without them build unchanged.
  "0b4d696417db45abd588ea0c6806a9041e210363c47cdf50ef880433646bd7f2": [
    "1d0838bcb131e259ce7cbdbb67d4d3b075e76d9cd8c18384af697598f3c951ab",
    "4df83644b7926264bd8dc2585ed16d3cf9e2b93b362ce3b68f41712238d01fb4",
    "d26ba79ff81a31651e7bc5ff3c9172999d85b98ecacaea7c655970ca5d0d245c",
    "bcf2044d3a9ecdc1b91e204e49bccecc5bd20a0325b2bb198c0d1b20da3e925c",
    "3854b01658e1aebb6f510c783fd5398fa1c2b9525ee1b96c16cc7d1389f03661",
    "5df7b415cee927487dce7dea5e1efb743d1a75b5fda7088e853da2e892bdf4b7",
    "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90",
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],

  // Orbit drags recover and angled steps probe the current blocking contact. Saved artifact contracts are unchanged.
  "1d0838bcb131e259ce7cbdbb67d4d3b075e76d9cd8c18384af697598f3c951ab": [
    "4df83644b7926264bd8dc2585ed16d3cf9e2b93b362ce3b68f41712238d01fb4",
    "d26ba79ff81a31651e7bc5ff3c9172999d85b98ecacaea7c655970ca5d0d245c",
    "bcf2044d3a9ecdc1b91e204e49bccecc5bd20a0325b2bb198c0d1b20da3e925c",
    "3854b01658e1aebb6f510c783fd5398fa1c2b9525ee1b96c16cc7d1389f03661",
    "5df7b415cee927487dce7dea5e1efb743d1a75b5fda7088e853da2e892bdf4b7",
    "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90",
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],

  // Room ceilings and the roof join both collision worlds; only Space yields to focused actions.
  "4df83644b7926264bd8dc2585ed16d3cf9e2b93b362ce3b68f41712238d01fb4": [
    "d26ba79ff81a31651e7bc5ff3c9172999d85b98ecacaea7c655970ca5d0d245c",
    "bcf2044d3a9ecdc1b91e204e49bccecc5bd20a0325b2bb198c0d1b20da3e925c",
    "3854b01658e1aebb6f510c783fd5398fa1c2b9525ee1b96c16cc7d1389f03661",
    "5df7b415cee927487dce7dea5e1efb743d1a75b5fda7088e853da2e892bdf4b7",
    "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90",
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],

  // Ground support follows collision resolution; angled steps retain clearance and obstruction guards.
  "d26ba79ff81a31651e7bc5ff3c9172999d85b98ecacaea7c655970ca5d0d245c": [
    "bcf2044d3a9ecdc1b91e204e49bccecc5bd20a0325b2bb198c0d1b20da3e925c",
    "3854b01658e1aebb6f510c783fd5398fa1c2b9525ee1b96c16cc7d1389f03661",
    "5df7b415cee927487dce7dea5e1efb743d1a75b5fda7088e853da2e892bdf4b7",
    "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90",
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
  // Reviewed wall joins, transparent shadows and grounded jump/step controls. Saved plan and asset contracts are unchanged.
  "bcf2044d3a9ecdc1b91e204e49bccecc5bd20a0325b2bb198c0d1b20da3e925c": [
    "3854b01658e1aebb6f510c783fd5398fa1c2b9525ee1b96c16cc7d1389f03661",
    "5df7b415cee927487dce7dea5e1efb743d1a75b5fda7088e853da2e892bdf4b7",
    "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90",
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
  // Softer overview daylight; authored materials, geometry, assets and saved artifacts are unchanged.
  "3854b01658e1aebb6f510c783fd5398fa1c2b9525ee1b96c16cc7d1389f03661": [
    "5df7b415cee927487dce7dea5e1efb743d1a75b5fda7088e853da2e892bdf4b7",
    "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90",
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
  // Quality rendering preserves authored finishes and the reviewed door/fixture contract.
  "5df7b415cee927487dce7dea5e1efb743d1a75b5fda7088e853da2e892bdf4b7": [
    "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90",
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
  // Clear sliding-door passages, matching tour routes and cancelled mount handling.
  "de3c67b050403fefe07d3a9486fb3e8ce0c791a33d89f303936b00ca967b1c90": [
    "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204",
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
  // Authored fixture overrides, closed initial door poses and fixed sliding-panel collision.
  "6104e28e993e9c1062fb035185c4457487e1aba344eb08e4036f2b917d7f6204": [
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
  // Resolution and AO settling.
  "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd": ["9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199"],
  // Clickable doors, room orbit, drag to pan and lamp shadow refresh.
  "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c": [
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
  // Walk start and loading, pipeline precompile, sun shadows and glass reflections.
  "b877cd74cb32faf79999cca0a2a56115c0f8fad641898c008f06ec6af2ce2906": [
    "9bbdf58f9b2c183f69bdd3034dbd521ea11d632b42c0ce0b8069afec74e6710c",
    "7e0436bc1b36dfca102c35f11b40a4be9a22d8c1fdbf0ea136cd06853b5445fd",
    "9347181d703461bfd63873589a89afda5a89e3a8ede79d6cba4ff13e46e22199",
  ],
};

/** Reviewed, directional rendering compatibility. Immutable artifacts retain their original runtime hash. */
export function viewerSupportsRuntime(viewerHash: string | undefined, artifactHash: string | undefined): boolean {
  if (!viewerHash || !artifactHash || !/^[a-f0-9]{64}$/.test(viewerHash) || !/^[a-f0-9]{64}$/.test(artifactHash)) return false;
  if (viewerHash === artifactHash) return true;
  return rendersOlder[viewerHash]?.includes(artifactHash) ?? false;
}
