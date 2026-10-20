import { z } from "zod";

export { projectIntakeSchema, type ProjectIntakePlan } from "./intake.ts";

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
  // Open sliding doors clear their passage; tours cross through the clear half.
  "e329a628e6c9b5d8b35c2fa5706e42340911d552bee3fb448fd478a62de94e48": [
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
};

/** Reviewed, directional rendering compatibility. Immutable artifacts retain their original runtime hash. */
export function viewerSupportsRuntime(viewerHash: string | undefined, artifactHash: string | undefined): boolean {
  if (!viewerHash || !artifactHash || !/^[a-f0-9]{64}$/.test(viewerHash) || !/^[a-f0-9]{64}$/.test(artifactHash)) return false;
  if (viewerHash === artifactHash) return true;
  return rendersOlder[viewerHash]?.includes(artifactHash) ?? false;
}
