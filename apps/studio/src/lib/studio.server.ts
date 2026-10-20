import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { addReviewNote, artifactDetails, artifactFile, buildProjectArtifact, inspectArtifact, inspectProject, listProjects, registerProject, inspectSource, viewerRuntimeHash, exportCheckpoint, importCheckpoint, restoreCheckpoint, checkpointBrief, referenceFile, readProjectIntake, readCheckpointIntake } from "@arch/project-tools";
import { initializeProject } from "@arch/project-tools/intake";
import { z } from "zod";
import { viewerSupportsRuntime } from "@arch/project";
import { changeCatalog, localCatalog, requireProject } from "./local-catalog";
import { requireStudio, studioOrigin } from "./local-session";
import { referenceHeaders } from "./reference-headers";
import type { StudioCatalog, StudioProjectDetails, StudioVersion } from "./model";
export { session } from "./local-session";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const previewKey = randomBytes(32);
async function capability(checkpointId: string, kind: "artifact" | "reference") {
  return createHmac("sha256", previewKey).update(`${kind}:${checkpointId}`).digest("hex");
}
async function location(checkpointId: string, origin: string) {
  const base = `${origin}/api/artifacts/${checkpointId}/${await capability(checkpointId, "artifact")}/`;
  return { planUrl: `${base}plan.json`, assetBase: `${base}library/`, base };
}
function referenceLocation(checkpointId: string, token: string, relative: string, origin: string) {
  return `${origin}/api/references/${checkpointId}/${token}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}
export async function catalog() { requireStudio(); return localCatalog(); }
export async function createClient({ data }: { data: { id: string; name: string } }) {
  requireStudio();
  return changeCatalog(catalog => {
    if (catalog.clients.some(client => client.id === data.id)) throw new Error("A client with this ID already exists.");
    catalog.clients.push(data); return data.id;
  });
}
export async function createProject({ data }: { data: { clientId: string; name: string } }) {
  requireStudio();
  return changeCatalog(catalog => {
    if (!catalog.clients.some(client => client.id === data.clientId)) throw new Error("Unknown client.");
    const id = randomUUID();
    catalog.projects.push({ id, ...data, sourceId: null, createdAt: new Date().toISOString() });
    return id;
  });
}
export async function projectDetails({ data }: { data: { projectId: string } }): Promise<StudioProjectDetails> {
  const origin = requireStudio();
  const project = requireProject(await localCatalog(), data.projectId);
  if (!project.sourceId) return { project, source: null, intake: null, intakeError: null, versions: [], notes: [] };
  const inspection = await inspectProject(project.sourceId);
  const current = await inspectSource(inspection.project.directory);
  requireSourceIdentity(project, current);
  const versions: StudioVersion[] = [];
  for (const checkpoint of inspection.checkpoints) {
    const hasArtifact = checkpoint.project.schemaVersion === 2 && checkpoint.files.some(file => file.path === "outputs/artifact.json");
    let artifactHash: string | null = null;
    let outputs: StudioVersion["outputs"] = [];
    if (hasArtifact) {
      const verified = await artifactDetails({ checkpointId: checkpoint.id });
      artifactHash = verified.artifactHash;
      const urls = await location(checkpoint.id, origin);
      outputs = verified.artifact.outputs.map((output, index) => ({ id: `${output.kind}-${index}`, kind: output.kind === "video" ? "film" : "still", label: path.basename(output.path), url: `${urls.base}${output.path.replace(/^outputs\/artifact\//, "").split("/").map(encodeURIComponent).join("/")}` }));
    }
    const token = await capability(checkpoint.id, "reference");
    let checkpointIntake: StudioVersion["intake"] = null;
    let checkpointIntakeError: string | null = null;
    try { checkpointIntake = await readCheckpointIntake(checkpoint.id); }
    catch (error) { checkpointIntakeError = error instanceof Error ? error.message : "Invalid saved project intake."; }
    versions.push({ id: checkpoint.id, checkpointId: checkpoint.id, createdAt: checkpoint.createdAt, hasArtifact, artifactHash, intake: checkpointIntake, intakeError: checkpointIntakeError, outputs, references: checkpoint.project.references.map(reference => ({ ...reference, url: referenceLocation(checkpoint.id, token, reference.path, origin) })) });
  }
  let intake: StudioProjectDetails["intake"] = null;
  let intakeError: string | null = null;
  try { intake = await readProjectIntake(current.directory); }
  catch (error) { intakeError = error instanceof Error ? error.message : "Invalid project intake."; }
  return { project, source: { ...inspection.project, manifest: current.manifest }, intake, intakeError, versions, notes: inspection.notes };
}
function requireSourceIdentity(project: StudioProjectDetails["project"], source: Pick<Awaited<ReturnType<typeof inspectSource>>, "manifest">) {
  if (project.sourceId && source.manifest.id !== project.sourceId) throw new Error("The source identity changed. Open the correct source folder.");
  if (source.manifest.client.id !== project.clientId) throw new Error("The source client ID must exactly match the selected client ID. Restore this project's original client ID before continuing.");
}
function attachSource(catalog: StudioCatalog, projectId: string, source: Awaited<ReturnType<typeof registerProject>>) {
  const project = requireProject(catalog, projectId);
  requireSourceIdentity(project, source);
  if (project.sourceId && project.sourceId !== source.manifest.id) throw new Error("This project already has a source.");
  if (catalog.projects.some(other => other.id !== project.id && other.sourceId === source.manifest.id)) throw new Error("This source already belongs to another Studio project.");
  project.sourceId = source.manifest.id;
  return source;
}
export async function openProjectFolder({ data }: { data: { directory: string } }): Promise<{ clientId: string; projectId: string }> {
  requireStudio();
  const source = await changeCatalog(async catalog => {
    const inspected = await inspectSource(data.directory);
    const bound = catalog.projects.find(project => project.sourceId === inspected.manifest.id);
    if (bound) requireSourceIdentity(bound, inspected);
    const registered = await registerProject(data.directory);
    if (bound) requireSourceIdentity(bound, registered);
    return registered;
  });
  const catalog = await localCatalog();
  const project = catalog.projects.find(project => project.sourceId === source.manifest.id);
  if (!project) throw new Error("The source was not imported into Studio.");
  requireSourceIdentity(project, source);
  return { clientId: project.clientId, projectId: project.id };
}
export async function registerSource({ data }: { data: { directory: string; projectId: string } }) {
  requireStudio();
  return changeCatalog(async catalog => {
    const source = await inspectSource(data.directory);
    attachSource(catalog, data.projectId, source);
    const registered = await registerProject(data.directory);
    return attachSource(catalog, data.projectId, registered);
  });
}
export async function initializeSource({ data }: { data: { inputsDirectory: string; directory: string; projectId: string } }) {
  requireStudio();
  return changeCatalog(async catalog => {
    const project = requireProject(catalog, data.projectId);
    if (project.sourceId) throw new Error("This project already has a source. Continue that folder instead.");
    const client = catalog.clients.find(client => client.id === project.clientId);
    if (!client) throw new Error("Unknown client.");
    const id = `source-${randomBytes(12).toString("hex")}`;
    // Initialization creates this exact identity from catalog values; no existing
    // source is registered before the selected project's binding is validated.
    const initialized = await initializeProject({ inputsDirectory: data.inputsDirectory, directory: data.directory, id, name: project.name, client });
    return attachSource(catalog, project.id, initialized.project);
  });
}
async function requireSourceBinding(projectId: string, sourceId: string) {
  return changeCatalog(async catalog => {
    const project = requireProject(catalog, projectId);
    if (project.sourceId !== sourceId) throw new Error("The source does not belong to this Studio project.");
    const source = (await listProjects()).find(source => source.manifest.id === sourceId);
    if (!source) throw new Error("Open the source folder first.");
    const current = await inspectSource(source.directory);
    if (current.manifest.id !== sourceId) throw new Error("The source identity changed. Open the correct source folder.");
    attachSource(catalog, projectId, current);
    const registered = await registerProject(source.directory);
    attachSource(catalog, projectId, registered);
    return project;
  });
}
export async function buildVersion({ data }: { data: { sourceId: string; projectId: string; authorizeSourceExecution: true } }) {
  requireStudio();
  if (data.authorizeSourceExecution !== true) throw new Error("Building requires explicit permission to execute trusted source code.");
  const project = await requireSourceBinding(data.projectId, data.sourceId);
  const built = await buildProjectArtifact(data.sourceId, { authorizeSourceExecution: true });
  if (built.checkpoint.project.id !== data.sourceId || built.checkpoint.project.client.id !== project.clientId) throw new Error("The built source identity does not match this project.");
  await requireSourceBinding(data.projectId, data.sourceId);
  return { versionId: built.checkpoint.id, checkpointId: built.checkpoint.id, artifactHash: built.artifactHash };
}
export async function openVersion({ data }: { data: { checkpointId: string } }) {
  const origin = requireStudio();
  const verified = await inspectArtifact(data);
  if (!viewerSupportsRuntime(await viewerRuntimeHash(), verified.artifact.runtimeHash)) throw new Error("This version requires a different viewer runtime. Export it to continue with the matching CLI.");
  return { ...await location(data.checkpointId, origin), artifactHash: verified.artifactHash };
}
export async function handoff({ data }: { data: { checkpointId: string; directory: string } }) { requireStudio(); return exportCheckpoint(data.checkpointId, data.directory); }
export async function brief({ data }: { data: { checkpointId: string } }) { requireStudio(); return checkpointBrief(data.checkpointId); }
export async function restoreSource({ data }: { data: { bundle: string; directory: string; activate?: boolean } }) {
  requireStudio();
  return changeCatalog(async catalog => {
    const checkpoint = await importCheckpoint(data.bundle);
    const bound = catalog.projects.find(project => project.sourceId === checkpoint.projectId);
    if (bound) requireSourceIdentity(bound, { manifest: checkpoint.project });
    // Switching an existing active folder requires a separate user choice.
    return restoreCheckpoint(checkpoint.id, data.directory, { activate: data.activate === true });
  });
}
export async function saveNote({ data }: { data: { projectId: string; checkpointId: string; body: string } }) {
  requireStudio(); const project = requireProject(await localCatalog(), data.projectId);
  if (!project.sourceId) throw new Error("Open a source folder before adding notes.");
  return addReviewNote(project.sourceId, { checkpointId: data.checkpointId, body: data.body, author: userInfo().username });
}
export async function referenceResponse(request: Request, checkpointId: string, token: string, relative: string) {
  try {
    const origin = studioOrigin(request); sha.parse(checkpointId); sha.parse(token);
    const expected = await capability(checkpointId, "reference");
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return new Response(null, { status: 404 });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    // TanStack has already decoded the route splat once.
    const pathname = relative;
    if (!pathname || pathname.includes("\\") || pathname.split("/").some(part => !part || part === "." || part === "..")) return new Response(null, { status: 404 });
    const content = await referenceFile({ checkpointId, path: pathname });
    const headers = referenceHeaders(pathname, content.body, content.contentType, origin, new URL(request.url).searchParams.get("inline") === "1");
    if (!headers) return new Response(null, { status: 415 });
    return new Response(request.method === "HEAD" ? null : new Uint8Array(content.body), { headers });
  } catch { return new Response(null, { status: 404 }); }
}
export async function artifactResponse(request: Request, checkpointId: string, token: string, relative: string) {
  try {
    const exactOrigin = studioOrigin(request);
    sha.parse(checkpointId); sha.parse(token);
    const expected = await capability(checkpointId, "artifact");
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return new Response(null, { status: 404 });
    const pathname = relative;
    if (!pathname || pathname.split("/").some(part => !part || part === "." || part === "..") || pathname.includes("\\")) return new Response(null, { status: 404 });
    const ext = path.extname(pathname);
    const types: Record<string, string> = { ".json": "application/json", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".hdr": "image/vnd.radiance", ".mp4": "video/mp4", ".webm": "video/webm" };
    if (!types[ext]) return new Response(null, { status: 404 });
    const content = await artifactFile(checkpointId, `outputs/artifact/${pathname}`);
    const headers = new Headers({ "Content-Type": types[ext], "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable", "Vary": "Origin", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes", "Content-Length": String(content.length), "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges" });
    const origin = request.headers.get("origin");
    if (origin === exactOrigin) { headers.set("Access-Control-Allow-Origin", origin); headers.set("Vary", "Origin"); }
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const suffix = match && !match[1] && match[2] ? Number(match[2]) : null;
      const start = suffix !== null ? Math.max(0, content.length - suffix) : Number(match?.[1]);
      const end = suffix !== null || !match?.[2] ? content.length - 1 : Math.min(Number(match[2]), content.length - 1);
      if (!match || (!match[1] && !match[2]) || suffix === 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= content.length) {
        headers.set("Content-Range", `bytes */${content.length}`);
        headers.set("Content-Length", "0");
        return new Response(null, { status: 416, headers });
      }
      headers.set("Content-Range", `bytes ${start}-${end}/${content.length}`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(request.method === "HEAD" ? null : new Uint8Array(content.subarray(start, end + 1)), { status: 206, headers });
    }
    return new Response(request.method === "HEAD" ? null : new Uint8Array(content), { headers });
  } catch { return new Response(null, { status: 404 }); }
}
