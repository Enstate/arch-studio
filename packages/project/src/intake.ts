import { z } from "zod";
import { projectId, relativeProjectPath } from "./index.ts";

// Resolve the shared primitives lazily because index.ts re-exports this contract.
const intakeId = z.lazy(() => projectId);
const intakeDocumentSchema = z.object({
  id: intakeId,
  path: z.lazy(() => relativeProjectPath),
  page: z.number().int().positive(),
  label: z.string().min(1).max(160),
  level: z.string().min(1).max(160).optional(),
  revision: z.string().min(1).max(160).optional(),
  role: z.enum(["primary", "supporting", "duplicate", "unresolved"]),
  duplicateOf: intakeId.optional(),
}).strict();

const intakePieceSchema = z.object({
  id: intakeId,
  label: z.string().min(1).max(160),
  scope: z.string().min(1).max(4000),
  documentIds: z.array(intakeId).min(1).max(100),
  dependsOn: z.array(intakeId).max(100),
  status: z.enum(["planned", "blocked", "ready"]),
  nextAction: z.string().min(1).max(4000),
}).strict();

export const projectIntakeSchema = z.object({
  version: z.literal(1),
  brief: z.string().min(1).max(8000),
  style: z.string().max(4000),
  documents: z.array(intakeDocumentSchema).max(1000),
  pieces: z.array(intakePieceSchema).max(100),
}).strict().superRefine((plan, context) => {
  const documents = new Map(plan.documents.map(document => [document.id, document]));
  const pieces = new Map(plan.pieces.map(piece => [piece.id, piece]));
  const documentIds = new Set<string>();
  const documentPages = new Set<string>();
  const pieceIds = new Set<string>();
  for (const [index, document] of plan.documents.entries()) {
    if (documentIds.has(document.id))
      context.addIssue({ code: "custom", path: ["documents", index, "id"], message: "Document IDs must be unique." });
    documentIds.add(document.id);
    const page = JSON.stringify([document.path, document.page]);
    if (documentPages.has(page))
      context.addIssue({ code: "custom", path: ["documents", index, "page"], message: "Each reference page must have exactly one document entry." });
    documentPages.add(page);
    if (document.role === "duplicate") {
      const original = document.duplicateOf ? documents.get(document.duplicateOf) : undefined;
      if (!original || original.id === document.id || original.role === "duplicate")
        context.addIssue({ code: "custom", path: ["documents", index, "duplicateOf"], message: "A duplicate must name another nonduplicate document." });
    } else if (Object.hasOwn(document, "duplicateOf")) {
      context.addIssue({ code: "custom", path: ["documents", index, "duplicateOf"], message: "Only duplicate documents may have duplicateOf." });
    }
  }
  for (const [index, piece] of plan.pieces.entries()) {
    if (pieceIds.has(piece.id))
      context.addIssue({ code: "custom", path: ["pieces", index, "id"], message: "Piece IDs must be unique." });
    pieceIds.add(piece.id);
    for (const [link, id] of piece.documentIds.entries()) {
      if (!documents.has(id))
        context.addIssue({ code: "custom", path: ["pieces", index, "documentIds", link], message: "Unknown intake document." });
    }
    for (const [link, id] of piece.dependsOn.entries()) {
      if (!pieces.has(id))
        context.addIssue({ code: "custom", path: ["pieces", index, "dependsOn", link], message: "Unknown intake piece dependency." });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function hasDependencyCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of pieces.get(id)?.dependsOn ?? []) {
      if (hasDependencyCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if (plan.pieces.some(piece => hasDependencyCycle(piece.id)))
    context.addIssue({ code: "custom", path: ["pieces"], message: "Intake piece dependencies must not contain cycles." });
});

export type ProjectIntakePlan = z.infer<typeof projectIntakeSchema>;
