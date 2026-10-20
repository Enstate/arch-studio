import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { studioSession, studioSessionHeader } from "./browser-session";

const localSession = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const current = new Headers();
  const secret = studioSession();
  if (secret) current.set(studioSessionHeader, secret);
  return next({ headers: current });
});
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(160);
const directory = z.string().min(1).max(4096);
export const session = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ token: sha.optional() }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.session(data); });
export const catalog = createServerFn({ method: "GET" }).middleware([localSession]).handler(async () => { const operations = await import("./studio.server"); return operations.catalog(); });
export const projectDetails = createServerFn({ method: "GET" }).middleware([localSession]).validator((input: unknown) => z.object({ projectId: id }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.projectDetails({ data }); });
export const createClient = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), name }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.createClient({ data }); });
export const createProject = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ clientId: id, name }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.createProject({ data }); });
export const registerSource = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ directory, projectId: id }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.registerSource({ data }); });
export const initializeSource = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ inputsDirectory: directory, directory, projectId: id }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.initializeSource({ data }); });
export const buildVersion = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ sourceId: id, projectId: id, authorizeSourceExecution: z.literal(true) }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.buildVersion({ data }); });
export const openVersion = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ checkpointId: sha }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.openVersion({ data }); });
export const handoff = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ checkpointId: sha, directory }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.handoff({ data }); });
export const brief = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ checkpointId: sha }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.brief({ data }); });
export const restoreSource = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ bundle: directory, directory, activate: z.boolean().optional() }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.restoreSource({ data }); });
export const saveNote = createServerFn({ method: "POST" }).middleware([localSession]).validator((input: unknown) => z.object({ projectId: id, checkpointId: sha, body: z.string().trim().min(1).max(8000) }).strict().parse(input)).handler(async ({ data }) => { const operations = await import("./studio.server"); return operations.saveNote({ data }); });
