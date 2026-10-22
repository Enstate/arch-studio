import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  exportProjectPackage, hasUnsavedChanges, importProjectPackage, inspectProjectPackage, machinePathRedactor, projectBranches, saveBranchCheckpoint, studioStoreDirectory,
  type ProjectPackage, type ProjectPackageMerge, type ProjectPackageStudio,
} from "@arch/project-tools";
import { z } from "zod";
import { changeCatalog, localCatalog, requireProject } from "./local-catalog";
import { requireStudio, studioOrigin } from "./local-session";
import type { ProjectFilePreview } from "./model";
import { holdProject, rounds, runningBranches } from "./rounds.server";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const moment = z.string().min(1).max(64);
// Studio resolves its own zod, so the shared @arch/project schemas are restated here.
const branchName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const agentProviderSchema = z.enum(["claude", "codex"]);
const roundAttachmentSchema = z.object({ name: z.string().min(1).max(260), sha256: sha, size: z.number().int().nonnegative(), mimeType: z.string().min(1).max(120) }).strict();
const exportLifetime = 60 * 60 * 1000;
const stagedLifetime = 60 * 60 * 1000;
const projectFileBytes = 2 * 1024 * 1024 * 1024;
const exportKey = randomBytes(32);
/** Download names of recent exports. Tokens die with this process, so the names may too. */
const exportNames = new Map<string, string>();

/**
 * Conversations travel with the project: threads, rounds, their events and each thread's
 * agent choice. Agent sessions and build grants stay on this machine; the receiving person
 * starts fresh sessions and grants source execution again.
 */
const studioPackageSchema = z
  .object({
    threads: z.array(z.object({ id: uuid, branch: branchName, title: z.string().min(1).max(500), createdAt: moment, settledOverride: z.enum(["settled", "active"]).nullable(), settledAt: moment.nullable(), snoozedUntil: moment.nullable(), snoozedAt: moment.nullable(), lastVisitedAt: moment.nullable(), archivedAt: moment.nullable() }).strict()).max(10_000),
    rounds: z.array(z.object({ id: uuid, threadId: uuid.nullable(), branch: branchName, kind: z.enum(["request", "critique", "build"]), status: z.enum(["running", "completed", "failed", "interrupted"]), request: z.string().max(100_000).nullable(), attachments: z.array(roundAttachmentSchema).max(20), provider: agentProviderSchema.nullable(), model: z.string().max(120).nullable(), parentCheckpointId: sha.nullable(), checkpointId: sha.nullable(), summary: z.string().max(200_000).nullable(), error: z.string().max(200_000).nullable(), startedAt: moment, completedAt: moment.nullable() }).strict()).max(100_000),
    roundEvents: z.array(z.object({ roundId: uuid, seq: z.number().int().nonnegative(), event: z.object({ type: z.string().min(1).max(40) }).passthrough() }).strict()).max(5_000_000),
    threadAgents: z.array(z.object({ threadId: uuid, provider: agentProviderSchema, model: z.string().min(1).max(120), settings: z.record(z.string().max(40), z.union([z.string().max(200), z.boolean()])) }).strict()).max(10_000),
  })
  .strict();
type StudioPackage = z.infer<typeof studioPackageSchema>;

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const imageBlob = (event: { type: string }) => (event.type === "image" && "sha256" in event ? String(event.sha256) : null);

/**
 * This project's conversations on `branches` from the local rounds database, plus the blobs
 * they show. `redact` removes this machine's folder paths from their text.
 */
function studioConversations(sourceId: string, branches: ReadonlySet<string>, redact: (text: string) => string): { value: StudioPackage; blobs: string[] } {
  const database = rounds();
  const redacted = (value: unknown) => { const plain = text(value); return plain === null ? null : redact(plain); };
  const threads = database.prepare("SELECT * FROM threads WHERE source_id=? ORDER BY created_at").all(sourceId).filter(row => branches.has(String(row.branch)));
  const threadIds = new Set(threads.map(row => String(row.id)));
  const roundRows = database.prepare("SELECT * FROM rounds WHERE source_id=? ORDER BY started_at").all(sourceId)
    .filter(row => branches.has(String(row.branch)) && (row.thread_id === null || threadIds.has(String(row.thread_id))));
  const roundIds = new Set(roundRows.map(row => String(row.id)));
  const value = studioPackageSchema.parse({
    threads: threads.map(row => ({
      id: String(row.id), branch: String(row.branch), title: String(row.title), createdAt: String(row.created_at),
      settledOverride: text(row.settled_override), settledAt: text(row.settled_at), snoozedUntil: text(row.snoozed_until),
      snoozedAt: text(row.snoozed_at), lastVisitedAt: text(row.last_visited_at), archivedAt: text(row.archived_at),
    })),
    rounds: roundRows.map(row => ({
      id: String(row.id), threadId: text(row.thread_id), branch: String(row.branch), kind: String(row.kind),
      // A round still running here cannot finish on the receiving machine.
      status: row.status === "running" ? "interrupted" : String(row.status),
      request: redacted(row.request), attachments: JSON.parse(String(row.attachments)) as unknown, provider: text(row.provider), model: text(row.model),
      parentCheckpointId: text(row.parent_checkpoint_id), checkpointId: text(row.checkpoint_id), summary: redacted(row.summary), error: redacted(row.error),
      startedAt: String(row.started_at), completedAt: text(row.completed_at),
    })),
    roundEvents: database.prepare("SELECT round_events.round_id, round_events.seq, round_events.event FROM round_events JOIN rounds ON rounds.id=round_events.round_id WHERE rounds.source_id=? ORDER BY round_events.round_id, round_events.seq").all(sourceId)
      .filter(row => roundIds.has(String(row.round_id)))
      // The serialized event is redacted, so paths inside nested and escaped strings go too.
      .map(row => ({ roundId: String(row.round_id), seq: Number(row.seq), event: JSON.parse(redact(String(row.event))) as unknown })),
    threadAgents: database.prepare("SELECT thread_agents.* FROM thread_agents JOIN threads ON threads.id=thread_agents.thread_id WHERE threads.source_id=?").all(sourceId)
      .filter(row => threadIds.has(String(row.thread_id)))
      .map(row => ({ threadId: String(row.thread_id), provider: String(row.provider), model: String(row.model), settings: JSON.parse(String(row.settings)) as unknown })),
  });
  const blobs = new Set([...value.rounds.flatMap(round => round.attachments.map(attachment => attachment.sha256)), ...value.roundEvents.flatMap(row => imageBlob(row.event) ?? [])]);
  return { value, blobs: [...blobs] };
}

/** Validate imported conversations against the package and this machine before anything is written. */
function acceptConversations(value: unknown, contents: ProjectPackage): StudioPackage {
  const data = studioPackageSchema.parse(value ?? { threads: [], rounds: [], roundEvents: [], threadAgents: [] });
  const branches = new Set(contents.branches.map(line => line.name));
  const checkpoints = new Set(contents.checkpoints);
  const blobs = new Map(contents.blobs.map(blob => [blob.sha256, blob.size]));
  const threads = new Set<string>();
  for (const thread of data.threads) {
    if (threads.has(thread.id) || !branches.has(thread.branch)) throw new Error("Imported thread target mismatch");
    threads.add(thread.id);
  }
  const roundIds = new Set<string>();
  for (const round of data.rounds) {
    if (roundIds.has(round.id) || !branches.has(round.branch) || (round.threadId && !threads.has(round.threadId))) throw new Error("Imported round target mismatch");
    if ((round.checkpointId && !checkpoints.has(round.checkpointId)) || (round.parentCheckpointId && !checkpoints.has(round.parentCheckpointId))) throw new Error("Imported round checkpoint is missing");
    for (const attachment of round.attachments) if (blobs.get(attachment.sha256) !== attachment.size) throw new Error("Imported round attachment is missing");
    roundIds.add(round.id);
  }
  const events = new Set<string>();
  for (const row of data.roundEvents) {
    const key = `${row.roundId}:${row.seq}`;
    if (events.has(key) || !roundIds.has(row.roundId)) throw new Error("Imported round event target mismatch");
    const image = imageBlob(row.event);
    if (row.event.type === "image" && (!image || !blobs.has(image))) throw new Error("Imported round image is missing");
    events.add(key);
  }
  const agents = new Set<string>();
  for (const agent of data.threadAgents) {
    if (agents.has(agent.threadId) || !threads.has(agent.threadId)) throw new Error("Imported thread agent target mismatch");
    agents.add(agent.threadId);
  }
  // An ID already here must belong to this project. Its local row is kept as it is.
  const database = rounds();
  const owner = (table: "threads" | "rounds", id: string) => database.prepare(`SELECT source_id FROM ${table} WHERE id=?`).get(id)?.source_id;
  for (const [table, ids] of [["threads", threads], ["rounds", roundIds]] as const)
    for (const id of ids) {
      const source = owner(table, id);
      if (source !== undefined && String(source) !== contents.projectId) throw new Error("Imported conversation belongs to another project");
    }
  return data;
}

/** Conversations the data adds here: new threads, and threads here that gain new rounds. */
function newConversations(data: StudioPackage): number {
  const database = rounds();
  const has = (table: "threads" | "rounds", id: string) => !!database.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id);
  const threads = new Set(data.threads.filter(thread => !has("threads", thread.id)).map(thread => thread.id));
  for (const round of data.rounds) if (round.threadId && !has("rounds", round.id)) threads.add(round.threadId);
  return threads.size;
}

/**
 * Add the conversations this machine does not have yet, in one transaction. Rows already here
 * stay as they are. Rows of a branch kept separately move to its new name; a new round whose
 * thread here is on another branch starts a thread of its own on the new branch.
 */
function storeConversations(sourceId: string, data: StudioPackage, merge: ProjectPackageMerge | null) {
  const renamed = new Map((merge?.variants ?? []).flatMap(variant => (variant.as ? [[variant.name, variant.as] as const] : [])));
  const branchOf = (name: string) => renamed.get(name) ?? name;
  const database = rounds();
  database.exec("BEGIN IMMEDIATE");
  try {
    const localThread = database.prepare("SELECT branch FROM threads WHERE id=?");
    const localRound = database.prepare("SELECT 1 FROM rounds WHERE id=?");
    const localAgent = database.prepare("SELECT 1 FROM thread_agents WHERE thread_id=?");
    const insertThread = database.prepare("INSERT INTO threads(id,source_id,branch,title,created_at,settled_override,settled_at,snoozed_until,snoozed_at,last_visited_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const insertAgent = database.prepare("INSERT INTO thread_agents(thread_id,provider,model,settings) VALUES(?,?,?,?)");
    const incomingThreads = new Map(data.threads.map(thread => [thread.id, thread]));
    const incomingAgents = new Map(data.threadAgents.map(agent => [agent.threadId, agent]));
    const addThread = (thread: StudioPackage["threads"][number], id: string, branch: string) => {
      insertThread.run(id, sourceId, branch, thread.title, thread.createdAt, thread.settledOverride, thread.settledAt, thread.snoozedUntil, thread.snoozedAt, thread.lastVisitedAt, thread.archivedAt);
      const agent = incomingAgents.get(thread.id);
      if (agent && !localAgent.get(id)) insertAgent.run(id, agent.provider, agent.model, JSON.stringify(agent.settings));
    };
    for (const thread of data.threads) if (!localThread.get(thread.id)) addThread(thread, thread.id, branchOf(thread.branch));
    // A thread here without an agent choice takes the incoming one.
    for (const agent of data.threadAgents) if (!localAgent.get(agent.threadId)) insertAgent.run(agent.threadId, agent.provider, agent.model, JSON.stringify(agent.settings));
    const split = new Map<string, string>();
    const threadFor = (threadId: string, branch: string) => {
      if (String(localThread.get(threadId)!.branch) === branch) return threadId;
      const key = `${threadId}:${branch}`;
      let id = split.get(key);
      if (!id) {
        id = randomUUID();
        addThread(incomingThreads.get(threadId)!, id, branch);
        split.set(key, id);
      }
      return id;
    };
    const insertRound = database.prepare("INSERT INTO rounds(id,source_id,branch,thread_id,kind,status,request,attachments,provider,model,parent_checkpoint_id,checkpoint_id,summary,error,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const added = new Set<string>();
    for (const item of data.rounds) {
      if (localRound.get(item.id)) continue;
      const branch = branchOf(item.branch);
      insertRound.run(item.id, sourceId, branch, item.threadId && threadFor(item.threadId, branch), item.kind, item.status === "running" ? "interrupted" : item.status, item.request, JSON.stringify(item.attachments), item.provider, item.model, item.parentCheckpointId, item.checkpointId, item.summary, item.error, item.startedAt, item.completedAt);
      added.add(item.id);
    }
    const event = database.prepare("INSERT INTO round_events(round_id,seq,event) VALUES(?,?,?)");
    for (const item of data.roundEvents) if (added.has(item.roundId)) event.run(item.roundId, item.seq, JSON.stringify(item.event));
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

/** Studio's part of reading a package. `hold` guards a merge; a preview only asks which branches are busy. */
function conversationHooks(hold: ProjectPackageStudio<StudioPackage>["hold"]): ProjectPackageStudio<StudioPackage> & { sourceId(): string } {
  let sourceId = "";
  return {
    sourceId: () => sourceId,
    accept: (value, contents) => {
      sourceId = contents.projectId;
      return acceptConversations(value, contents);
    },
    added: newConversations,
    publish: (value, merge) => storeConversations(sourceId, value, merge),
    hold,
  };
}

function capability(exportId: string) {
  return createHmac("sha256", exportKey).update(`export:${exportId}`).digest("hex");
}
async function privateDirectory(...parts: string[]) {
  const directory = path.join(studioStoreDirectory(), ...parts);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return directory;
}
async function removeExpired(directory: string, lifetime: number, removed?: (name: string) => void) {
  for (const name of await fs.readdir(directory)) {
    const stat = await fs.lstat(path.join(directory, name)).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs <= lifetime) continue;
    await fs.rm(path.join(directory, name), { recursive: true, force: true });
    removed?.(name);
  }
}
function packageFileName(name: string) {
  const base = [...name.normalize("NFC")].map(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f ? "-" : character).join("").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120).trim();
  return `${base || "project"}.archproject`;
}

/**
 * Save each active branch folder's changes as a version, so the file holds the latest work.
 * Saving only reads files; it never runs project code. Returns the branches whose folder
 * changes stay out of the file: a round works in them, or their folder cannot be saved.
 */
async function saveBranchChanges(sourceId: string): Promise<string[]> {
  const lines = (await projectBranches(sourceId)).branches.filter(line => !line.archived);
  return holdProject(sourceId, lines.map(line => line.name), async running => {
    const unsaved: string[] = [];
    for (const line of lines) {
      try {
        if (!(await hasUnsavedChanges(sourceId, line.name))) continue;
        if (running.has(line.name)) unsaved.push(line.name);
        else await saveBranchCheckpoint(sourceId, line.name);
      } catch { unsaved.push(line.name); }
    }
    return unsaved;
  });
}

/** Package the whole project into one file and return a short-lived download capability for it. */
export async function exportProject({ data }: { data: { projectId: string } }): Promise<{ url: string; fileName: string; bytes: number; unsaved: string[] }> {
  const origin = requireStudio();
  const project = requireProject(await localCatalog(), data.projectId);
  if (!project.sourceId) throw new Error("ARCH_SOURCE_REQUIRED");
  const sourceId = project.sourceId;
  const unsaved = await saveBranchChanges(sourceId);
  const directory = await privateDirectory("exports");
  await removeExpired(directory, exportLifetime, name => exportNames.delete(name.replace(/\.archproject$/, "")));
  const exportId = randomUUID();
  // Branches without a version stay out of the file, and so do their conversations.
  const versioned = new Set((await projectBranches(sourceId)).branches.flatMap(line => (line.headId ? [line.name] : [])));
  const conversations = studioConversations(sourceId, versioned, await machinePathRedactor(sourceId));
  const { bytes, skipped } = await exportProjectPackage(sourceId, path.join(directory, `${exportId}.archproject`), { name: project.name, studio: conversations.value, blobs: conversations.blobs });
  const fileName = packageFileName(project.name);
  exportNames.set(exportId, fileName);
  return { url: `${origin}/api/exports/${exportId}/${capability(exportId)}`, fileName, bytes, unsaved: [...new Set([...unsaved, ...skipped])] };
}

/** Copy a project file chosen on this machine. Only a regular file is read, never through a link. */
async function copyLocalProjectFile(source: string, target: string) {
  if (!path.isAbsolute(source) || !/\.archproject$/i.test(source)) throw new Error("ARCH_PACKAGE_INVALID");
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === "win32" ? 0 : constants.O_NONBLOCK ?? 0);
  const handle = await fs.open(source, flags).catch(() => { throw new Error("ARCH_PACKAGE_INVALID"); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > projectFileBytes) throw new Error("ARCH_PACKAGE_INVALID");
    await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(target, { flags: "wx", mode: 0o600 }));
  } finally { await handle.close(); }
}

/**
 * Stage a project file and check it fully without changing any project. The preview says
 * what the file holds and, for a project already here, what opening it would add.
 */
export async function stageProjectFile({ data }: { data: { file: File } | { path: string } }): Promise<ProjectFilePreview> {
  requireStudio();
  const directory = await privateDirectory("staging", "packages");
  await removeExpired(directory, stagedLifetime);
  const uploadId = randomUUID();
  const file = path.join(directory, `${uploadId}.archproject`);
  try {
    if ("file" in data) await pipeline(Readable.fromWeb(data.file.stream() as unknown as NodeReadableStream), createWriteStream(file, { flags: "wx", mode: 0o600 }));
    else await copyLocalProjectFile(data.path, file);
    const hooks = conversationHooks((projectId, _branches, work) => work(runningBranches(projectId)));
    const inspected = await inspectProjectPackage(file, hooks);
    const { contents, merge } = inspected;
    const existing = merge ? (await localCatalog()).projects.find(project => project.sourceId === contents.projectId) ?? null : null;
    return {
      uploadId,
      name: contents.name,
      clientName: contents.client.name,
      versions: inspected.builtVersions,
      conversations: inspected.studio?.threads.length ?? 0,
      notes: contents.notes.length,
      existing: existing && { projectId: existing.id, name: existing.name },
      changes: merge && { versions: merge.builtCheckpoints, conversations: merge.conversations, notes: merge.notes, variants: merge.variants.filter(variant => variant.outcome !== "unchanged") },
    };
  } catch (error) {
    await fs.rm(file, { force: true });
    throw error;
  }
}

/**
 * Open a staged project file: a new project is added, a project already here gains what it
 * lacks. The outcome is decided again against the current state. The staged file is removed
 * afterwards, except when the project is busy, so the person can try again.
 */
export async function openProjectFile({ data }: { data: { uploadId: string } }): Promise<{ projectId: string; outcome: "added" | "updated" | "unchanged" }> {
  requireStudio();
  const file = path.join(await privateDirectory("staging", "packages"), `${uuid.parse(data.uploadId)}.archproject`);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || Date.now() - stat.mtimeMs > stagedLifetime) {
    await fs.rm(file, { force: true });
    throw new Error("ARCH_PACKAGE_EXPIRED");
  }
  let keep = false;
  try {
    const hooks = conversationHooks(holdProject);
    const imported = await importProjectPackage(file, hooks);
    const sourceId = hooks.sourceId();
    if (imported.merge) return { projectId: requireBound(await localCatalog(), sourceId).id, outcome: imported.outcome };
    const { client, name } = imported.contents;
    const projectId = await changeCatalog(catalog => {
      if (!catalog.clients.some(item => item.id === client.id)) catalog.clients.push(client);
      // Listing projects may already have picked up the new source under its folder name.
      const bound = catalog.projects.find(project => project.sourceId === sourceId);
      if (bound) {
        if (bound.id === `source:${sourceId}`) bound.name = name;
        return bound.id;
      }
      const id = randomUUID();
      catalog.projects.push({ id, clientId: client.id, name, sourceId, createdAt: new Date().toISOString() });
      return id;
    });
    return { projectId, outcome: imported.outcome };
  } catch (error) {
    keep = error instanceof Error && error.message === "ARCH_PROJECT_BUSY";
    throw error;
  } finally {
    if (!keep) await fs.rm(file, { force: true });
  }
}
function requireBound(catalog: Awaited<ReturnType<typeof localCatalog>>, sourceId: string) {
  const project = catalog.projects.find(item => item.sourceId === sourceId);
  if (!project) throw new Error("ARCH_ITEM_MISSING");
  return project;
}

/** Serve one finished export to its capability holder, streamed from disk. */
export async function exportResponse(request: Request, exportId: string, token: string) {
  try {
    studioOrigin(request);
    uuid.parse(exportId); sha.parse(token);
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(capability(exportId)))) return new Response(null, { status: 404 });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    // The name is built from a validated UUID, so it cannot leave the exports directory.
    const file = path.join(studioStoreDirectory(), "exports", `${exportId}.archproject`);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || Date.now() - stat.mtimeMs > exportLifetime) { await handle.close(); return new Response(null, { status: 404 }); }
      const fileName = exportNames.get(exportId) ?? "project.archproject";
      const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, "_");
      const headers = new Headers({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "Content-Length": String(stat.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      });
      if (request.method === "HEAD") { await handle.close(); return new Response(null, { headers }); }
      return new Response(Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>, { headers });
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  } catch (error) {
    console.error(`Export request failed: ${error instanceof Error ? error.message : String(error)}`);
    return new Response(null, { status: 404 });
  }
}
