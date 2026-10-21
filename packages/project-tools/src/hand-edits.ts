import type { PlanEdits } from "@arch/viewer/plan/edits";
import { z } from "zod";

const pair = z.tuple([z.number(), z.number()]);
const finishes = z.record(z.string(), z.object({ color: z.string(), pbr: z.string().optional(), texture: z.string().optional() }).passthrough());
/**
 * Outer shape of `source/edits.json`, the changes a person made by hand in the viewer. This
 * module has no Node imports, so Studio's server functions can check edits where they arrive.
 * The plan validator checks the pieces and finishes once a build has laid them over the plan.
 */
export const planEditsSchema = z.object({
  version: z.literal(1),
  furniture: z.record(z.string().min(1), z.object({ position: pair.optional(), rotation: z.number().optional(), removed: z.literal(true).optional() }).strict()).optional(),
  added: z.array(z.object({ id: z.string().min(1), type: z.string(), position: pair, model: z.string().optional(), material: z.string().optional(), accent: z.string().optional() }).passthrough()).optional(),
  surfaces: z.record(z.string().min(1), z.string().min(1)).optional(),
  materials: finishes.optional(),
  designOptions: z.record(z.string().min(1), finishes).optional(),
}).strict() as unknown as z.ZodType<PlanEdits>;
