import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const projectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

/** A branch name is part of a local folder path and must stay portable. */
export const branchName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const projectBranchSchema = z
  .object({
    name: branchName,
    directory: z.string().min(1),
    headId: sha256.nullable(),
    forkedFrom: sha256.nullable(),
    createdAt: z.string().datetime(),
    archived: z.boolean(),
  })
  .strict();
/** Local working lines for one project. The catalog entry always mirrors the primary branch. */
export const projectBranchesSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId,
    primary: branchName,
    branches: z.array(projectBranchSchema).min(1).max(100),
  })
  .strict();

export const agentProviderSchema = z.enum(["claude", "codex"]);
export const roundAttachmentSchema = z
  .object({
    name: z.string().min(1).max(260),
    sha256,
    size: z.number().int().nonnegative(),
    mimeType: z.string().min(1).max(120),
  })
  .strict();
/**
 * One completed unit of work that produced or reviewed a checkpoint. It lives beside
 * the checkpoint so checkpoint identity and the hosted format stay unchanged.
 */
export const roundSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    projectId,
    branch: branchName,
    kind: z.enum(["request", "critique", "build"]),
    checkpointId: sha256,
    parentCheckpointId: sha256.nullable(),
    request: z.string().max(20000).nullable(),
    attachments: z.array(roundAttachmentSchema).max(20),
    provider: agentProviderSchema.nullable(),
    model: z.string().max(120).nullable(),
    summary: z.string().max(40000).nullable(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  })
  .strict();

export type ProjectBranch = z.infer<typeof projectBranchSchema>;
export type ProjectBranches = z.infer<typeof projectBranchesSchema>;
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type RoundAttachment = z.infer<typeof roundAttachmentSchema>;
export type Round = z.infer<typeof roundSchema>;

export type CheckpointFileChange = { path: string; change: "added" | "removed" | "modified" };
export type PlanElementChanges = { added: string[]; removed: string[]; modified: string[] };
/** What changed between two checkpoints, from per-file hashes and the generated plans. */
export type CheckpointComparison = {
  base: string;
  target: string;
  files: CheckpointFileChange[];
  plan: Record<"walls" | "openings" | "rooms" | "furniture" | "cameras" | "materials", PlanElementChanges> | null;
};
