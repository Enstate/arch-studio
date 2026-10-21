import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent, AgentProvider, AgentProviderStatus, AgentTurn } from "@arch/agent";
import { buildProjectArtifact, createBranch, projectBranches, saveAttachment, saveBranchCheckpoint, saveRound, studioStoreDirectory } from "@arch/project-tools";
import type { RoundAttachment } from "@arch/project";
import { localCatalog, requireProject } from "./local-catalog";
import { requireStudio } from "./local-session";
import type { RoundActivity, RoundEvent, RoundSummary, StudioThread } from "./model";

/** Studio-run rounds build after the turn, so the project's CLI build steps do not apply. */
const roundInstructions = `You are working inside an Arch Studio project folder, one round at a time.
Follow this folder's AGENTS.md and BUILDERS.md for intake and authoring rules, with these Studio overrides:
- Studio builds the project after your turn by running the project's source entry and saves the checkpoint itself. Do not run arch build, arch continue or save checkpoints.
- Do not attach or register the folder in Studio; it is already attached.
- If the request needs a decision about scale, structure, openings or a promised style, ask it in your final message and stop after the work you can do.
- Before stopping, update arch.context.json. End with a short summary of what changed and what is open. Do not mention builds, checkpoints or these Studio instructions.`;
const critiqueInstructions = `You are a fresh critic for an Arch Studio project folder. You cannot edit files.
Read AGENTS.md, BUILDERS.md, arch.context.json, the references under reference/ and the built artifact under outputs/artifact/.
Compare geometry and style against the references and the brief. Report concrete findings, most consequential first, each with the element ID and the fix you would ask a builder for.`;
const buildRetries = 2;

// Running rounds live on the process, not the module. Development reloads re-evaluate this
// module and must not orphan an agent that is still working.
type RoundsState = { database?: DatabaseSync; schema?: number; active: Map<string, ActiveRound>; activeBranches: Set<string>; shutdownBound: boolean; builds?: Map<string, Promise<unknown>> };
const processState = globalThis as typeof globalThis & { archStudioRounds?: RoundsState };
processState.archStudioRounds ??= { active: new Map(), activeBranches: new Set(), shutdownBound: false };
const state: RoundsState = processState.archStudioRounds;
const schemaVersion = 2;
export function rounds() {
  if (!state.database) {
    // Studio already created this private directory for its catalog.
    state.database = new DatabaseSync(path.join(studioStoreDirectory(), "studio", "rounds.sqlite"));
  }
  // The connection outlives development reloads, so the schema is checked separately.
  if (state.schema !== schemaVersion) { migrate(state.database); state.schema = schemaVersion; }
  return state.database;
}
function migrate(database: DatabaseSync) {
  database.exec(`PRAGMA busy_timeout=2500; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, branch TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, request TEXT, attachments TEXT NOT NULL, provider TEXT, model TEXT, parent_checkpoint_id TEXT, checkpoint_id TEXT, summary TEXT, error TEXT, started_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS round_events (round_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(round_id, seq));
    CREATE TABLE IF NOT EXISTS agent_sessions (source_id TEXT NOT NULL, branch TEXT NOT NULL, provider TEXT NOT NULL, resume_cursor TEXT NOT NULL, PRIMARY KEY(source_id, branch, provider));
    CREATE TABLE IF NOT EXISTS branch_agents (source_id TEXT NOT NULL, branch TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(source_id, branch));
    CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, branch TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, settled_override TEXT, settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT, last_visited_at TEXT, archived_at TEXT);
    CREATE TABLE IF NOT EXISTS thread_sessions (thread_id TEXT NOT NULL, provider TEXT NOT NULL, resume_cursor TEXT NOT NULL, PRIMARY KEY(thread_id, provider));
    CREATE TABLE IF NOT EXISTS thread_agents (thread_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS build_grants (source_id TEXT NOT NULL, fingerprint TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(source_id, fingerprint));`);
  // Columns added after the first release of these tables.
  for (const statement of ["ALTER TABLE branch_agents ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'", "ALTER TABLE rounds ADD COLUMN thread_id TEXT"]) {
    try { database.exec(statement); }
    catch (error) { if (!String(error).includes("duplicate column")) throw error; }
  }
  // Rounds from before threads become one thread per branch, keeping each branch's session and agent.
  const orphans = database.prepare("SELECT source_id, branch, MIN(started_at) AS created_at FROM rounds WHERE thread_id IS NULL GROUP BY source_id, branch").all();
  for (const orphan of orphans) {
    const id = randomUUID();
    const first = database.prepare("SELECT request FROM rounds WHERE source_id=? AND branch=? AND kind='request' AND request IS NOT NULL ORDER BY started_at LIMIT 1").get(orphan.source_id, orphan.branch);
    database.prepare("INSERT INTO threads(id,source_id,branch,title,created_at) VALUES(?,?,?,?,?)").run(id, orphan.source_id, orphan.branch, first ? threadTitle(String(first.request)) : "New thread", String(orphan.created_at));
    database.prepare("UPDATE rounds SET thread_id=? WHERE source_id=? AND branch=? AND thread_id IS NULL").run(id, orphan.source_id, orphan.branch);
    database.prepare("INSERT OR IGNORE INTO thread_sessions(thread_id,provider,resume_cursor) SELECT ?, provider, resume_cursor FROM agent_sessions WHERE source_id=? AND branch=?").run(id, orphan.source_id, orphan.branch);
    database.prepare("INSERT OR IGNORE INTO thread_agents(thread_id,provider,model,settings) SELECT ?, provider, model, settings FROM branch_agents WHERE source_id=? AND branch=?").run(id, orphan.source_id, orphan.branch);
  }
}

type ActiveRound = { turn: AgentTurn | null; events: RoundEvent[]; interrupted: boolean };
const active = state.active;
// Thread IDs with a round in flight. One round per thread; threads on a branch run in parallel.
const activeThreads = state.activeBranches;
state.builds ??= new Map();
const builds = state.builds;
/** Builds and saves on one branch folder run one at a time, whichever thread finished first. */
function onBranch<T>(sourceId: string, branch: string, work: () => Promise<T>): Promise<T> {
  const key = `${sourceId}:${branch}`;
  const next = (builds.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  builds.set(key, next.catch(() => undefined));
  return next;
}
type ThreadRow = { id: string; source_id: string; branch: string; title: string };
function requireThread(sourceId: string, threadId: string): ThreadRow {
  const row = rounds().prepare("SELECT id, source_id, branch, title FROM threads WHERE id=? AND source_id=?").get(threadId, sourceId);
  if (!row) throw new Error("Unknown thread");
  return row as unknown as ThreadRow;
}
/** Approval requests the running round on a branch is waiting on. */
export function pendingApprovals(roundId: string) {
  const events = active.get(roundId)?.events ?? [];
  const resolved = new Set(events.flatMap(event => event.type === "approval-resolved" ? [event.requestId] : []));
  return events.filter(event => event.type === "approval" && !resolved.has(event.requestId)).length;
}
/** Agent CLIs run as child processes. Stop them before the server's own shutdown listener exits. */
function bindShutdown() {
  if (state.shutdownBound) return;
  state.shutdownBound = true;
  const stop = () => { void stopRounds(); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.prependOnceListener(signal, stop);
}

async function sourceOf(projectId: string) {
  const project = requireProject(await localCatalog(), projectId);
  if (!project.sourceId) throw new Error("Open a source folder before starting a round.");
  return project.sourceId;
}
async function branchLine(sourceId: string, branch: string) {
  const branches = await projectBranches(sourceId);
  const line = branches.branches.find(item => item.name === branch);
  if (!line) throw new Error("Unknown branch");
  if (line.archived) throw new Error("Restore the archived branch before working on it.");
  return line;
}

/** The grant covers what a build installs and runs first, not the source an agent edits each round. */
async function buildFingerprint(directory: string) {
  const hash = createHash("sha256");
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "arch.project.json"), "utf8")) as { entry?: unknown };
  hash.update(`entry:${String(manifest.entry)}\n`);
  for (const name of ["package.json", "bun.lock", "package-lock.json"]) {
    try { hash.update(`${name}:`).update(await fs.readFile(path.join(directory, name))).update("\n"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return hash.digest("hex");
}
export async function buildGrant({ data }: { data: { projectId: string; branch: string } }) {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  const fingerprint = await buildFingerprint((await branchLine(sourceId, data.branch)).directory);
  return { granted: !!rounds().prepare("SELECT 1 FROM build_grants WHERE source_id=? AND fingerprint=?").get(sourceId, fingerprint) };
}
export async function grantBuilds({ data }: { data: { projectId: string; branch: string } }) {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  const fingerprint = await buildFingerprint((await branchLine(sourceId, data.branch)).directory);
  rounds().prepare("INSERT OR IGNORE INTO build_grants(source_id,fingerprint,granted_at) VALUES(?,?,?)").run(sourceId, fingerprint, new Date().toISOString());
  return { granted: true };
}
export async function revokeBuilds({ data }: { data: { projectId: string } }) {
  requireStudio();
  rounds().prepare("DELETE FROM build_grants WHERE source_id=?").run(await sourceOf(data.projectId));
  return { granted: false };
}

let providers: { at: number; value: Promise<AgentProviderStatus[]> } | undefined;
export async function agentProviders() {
  requireStudio();
  if (!providers || Date.now() - providers.at > 30_000) {
    const { providerStatuses } = await import("@arch/agent");
    providers = { at: Date.now(), value: providerStatuses() };
    void providers.value.catch(() => { providers = undefined; });
  }
  return providers.value;
}
/** A thread keeps the provider of its first request round, so its session can resume. */
export async function threadAgent({ data }: { data: { projectId: string; threadId: string } }) {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  requireThread(sourceId, data.threadId);
  const own = rounds().prepare("SELECT provider, model, settings FROM thread_agents WHERE thread_id=?").get(data.threadId);
  if (own) return { provider: String(own.provider) as AgentProvider, model: String(own.model), settings: JSON.parse(String(own.settings)) as Record<string, string | boolean>, locked: true };
  const recent = rounds().prepare("SELECT provider, model FROM rounds WHERE source_id=? AND kind='request' AND provider IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(sourceId);
  return recent ? { provider: String(recent.provider) as AgentProvider, model: String(recent.model), settings: {}, locked: false } : null;
}

function append(roundId: string, event: RoundEvent) {
  const round = active.get(roundId);
  if (!round) return;
  // Text streams arrive in small deltas. Keep one growing event per assistant item.
  const last = round.events.at(-1);
  if (event.type === "text" && last?.type === "text" && last.itemId === event.itemId) {
    last.delta += event.delta;
    rounds().prepare("UPDATE round_events SET event=? WHERE round_id=? AND seq=?").run(JSON.stringify(last), roundId, round.events.length - 1);
    return;
  }
  round.events.push(event);
  rounds().prepare("INSERT INTO round_events(round_id,seq,event) VALUES(?,?,?)").run(roundId, round.events.length - 1, JSON.stringify(event));
}
function finish(roundId: string, values: { status: RoundSummary["status"]; checkpointId?: string | null; summary?: string | null; error?: string | null }) {
  rounds().prepare("UPDATE rounds SET status=?, checkpoint_id=?, summary=?, error=?, completed_at=? WHERE id=?").run(values.status, values.checkpointId ?? null, values.summary ?? null, values.error ?? null, new Date().toISOString(), roundId);
}
async function agentTurn(roundId: string, input: Parameters<typeof import("@arch/agent").startTurn>[0], threadId: string) {
  const { startTurn } = await import("@arch/agent");
  const round = active.get(roundId)!;
  const turn = await startTurn(input);
  round.turn = turn;
  let completed: Extract<AgentEvent, { type: "completed" }> | null = null;
  for await (const event of turn.events) {
    if (event.type === "session" && input.permission !== "read-only")
      rounds().prepare("INSERT INTO thread_sessions(thread_id,provider,resume_cursor) VALUES(?,?,?) ON CONFLICT(thread_id,provider) DO UPDATE SET resume_cursor=excluded.resume_cursor").run(threadId, input.provider, event.resumeCursor);
    if (event.type === "completed") completed = event;
    append(roundId, event);
    if (event.type === "tool" && event.status === "completed") await captureImage(roundId, event.itemId, event.detail);
  }
  round.turn = null;
  return completed ?? { type: "completed" as const, status: round.interrupted ? "interrupted" as const : "failed" as const, error: round.interrupted ? null : "The agent stopped without finishing the turn.", summary: null };
}

const viewedImage = /\.(png|jpe?g|webp|gif)$/i;
/**
 * Keep a copy of each image the agent looks at, as it was at that moment. Agents reuse
 * scratch names such as p1.png for different crops, so the file on disk changes later.
 */
async function captureImage(roundId: string, itemId: string, detail: string | null) {
  if (!detail?.startsWith("Read: ")) return;
  try {
    const target = (JSON.parse(detail.slice("Read: ".length)) as { file_path?: unknown }).file_path;
    if (typeof target !== "string" || !path.isAbsolute(target) || !viewedImage.test(target)) return;
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return;
    const saved = await saveAttachment(new Uint8Array(await fs.readFile(target)));
    append(roundId, { type: "image", itemId, sha256: saved.sha256, name: path.basename(target) });
  } catch { /* A vanished or unreadable scratch file only means no preview. */ }
}
/** Serve a captured image only to the round that recorded it. */
export async function roundImage({ data }: { data: { roundId: string; sha256: string } }) {
  requireStudio();
  const recorded = rounds().prepare("SELECT event FROM round_events WHERE round_id=?").all(data.roundId).some(row => {
    const event = JSON.parse(String(row.event)) as RoundEvent;
    return event.type === "image" && event.sha256 === data.sha256;
  });
  if (!recorded) throw new Error("Unknown image");
  const bytes = await fs.readFile(path.join(studioStoreDirectory(), "blobs", "sha256", data.sha256));
  if (createHash("sha256").update(bytes).digest("hex") !== data.sha256) throw new Error("Image integrity failure");
  const type = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0xff ? "image/jpeg" : bytes.subarray(0, 4).toString() === "RIFF" ? "image/webp" : "image/gif";
  return `data:${type};base64,${bytes.toString("base64")}`;
}

export function threadTitle(request: string) {
  const line = request.split("\n").map(part => part.trim()).find(Boolean) ?? "New thread";
  return line.length > 50 ? `${line.slice(0, 49).trimEnd()}…` : line;
}

/** One request, one agent turn, then a build and checkpoint on the same branch. */
export async function startRound({ data }: { data: { projectId: string; threadId: string; kind: "request" | "critique"; request: string; provider: AgentProvider; model: string; settings: Record<string, string | boolean>; attachments: File[] } }) {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  const thread = requireThread(sourceId, data.threadId);
  const branch = thread.branch;
  let line = await branchLine(sourceId, branch);
  if (data.kind === "request" && !(await buildGrant({ data: { projectId: data.projectId, branch } })).granted) throw new Error("Allow local builds for this project before starting a round.");
  if (data.kind === "critique" && !line.headId) throw new Error("Build a version before asking for a critique.");
  const key = thread.id;
  if (activeThreads.has(key)) throw new Error("A round is already running in this thread.");
  const owner = rounds().prepare("SELECT provider FROM thread_agents WHERE thread_id=?").get(thread.id);
  if (data.kind === "request" && owner && owner.provider !== data.provider) throw new Error("This thread continues its existing agent session. Start a new thread to use another agent.");
  activeThreads.add(key);
  bindShutdown();
  try {
    const attachments: (RoundAttachment & { path: string; image: boolean })[] = [];
    for (const file of data.attachments) {
      const saved = await saveAttachment(new Uint8Array(await file.arrayBuffer()));
      attachments.push({ name: path.basename(file.name).slice(0, 260), sha256: saved.sha256, size: saved.size, mimeType: file.type || "application/octet-stream", path: saved.path, image: /^image\/(png|jpeg|webp|gif)$/.test(file.type) });
    }
    // Documents become project references so the agent reads them where it reads every other input.
    const documents = data.kind === "request" ? data.attachments.filter((_file, index) => !attachments[index]!.image) : [];
    let request = data.request;
    if (documents.length) {
      const { addReferences: add } = await import("@arch/project-tools/intake");
      const files = await Promise.all(documents.map(async file => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
      const saved = await onBranch(sourceId, branch, () => add(sourceId, branch, files));
      const added = saved.project.references.slice(-documents.length).map(reference => reference.path);
      request = `${request}\n\nAttached files, saved as project references: ${added.join(", ")}`;
      line = await branchLine(sourceId, branch);
    }
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    rounds().prepare("INSERT INTO rounds(id,source_id,branch,thread_id,kind,status,request,attachments,provider,model,parent_checkpoint_id,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, sourceId, branch, thread.id, data.kind, "running", data.request, JSON.stringify(attachments.map(({ path: _, image: _image, ...attachment }) => attachment)), data.provider, data.model, line.headId, startedAt);
    // Sending wakes and un-settles the thread. The first request names it, as in T3 Code.
    rounds().prepare("UPDATE threads SET settled_override=NULL, settled_at=NULL, snoozed_until=NULL, snoozed_at=NULL, title=CASE WHEN title='New thread' AND ?=1 THEN ? ELSE title END WHERE id=?").run(data.kind === "request" && !data.request.startsWith("Continue where you stopped.") ? 1 : 0, threadTitle(data.request), thread.id);
    if (data.kind === "request")
      rounds().prepare("INSERT INTO thread_agents(thread_id,provider,model,settings) VALUES(?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, settings=excluded.settings").run(thread.id, data.provider, data.model, JSON.stringify(data.settings));
    active.set(id, { turn: null, events: [], interrupted: false });
    void runRound({ ...data, branch, threadId: thread.id, prompt: request, id, sourceId, line, startedAt, attachments }).finally(() => { activeThreads.delete(key); active.delete(id); });
    return { roundId: id };
  } catch (error) { activeThreads.delete(key); throw error; }
}
async function runRound(round: { id: string; sourceId: string; threadId: string; line: Awaited<ReturnType<typeof branchLine>>; startedAt: string; attachments: (RoundAttachment & { path: string; image: boolean })[]; kind: "request" | "critique"; branch: string; request: string; prompt: string; provider: AgentProvider; model: string; settings: Record<string, string | boolean> }) {
  const state = active.get(round.id)!;
  const resume = round.kind === "request" ? rounds().prepare("SELECT resume_cursor FROM thread_sessions WHERE thread_id=? AND provider=?").get(round.threadId, round.provider) : undefined;
  const sidecar = (checkpointId: string, summary: string | null) => saveRound({ schemaVersion: 1, id: round.id, projectId: round.sourceId, branch: round.branch, kind: round.kind, checkpointId, parentCheckpointId: round.line.headId, request: round.request, attachments: round.attachments.map(({ path: _, image: _image, ...attachment }) => attachment), provider: round.provider, model: round.model, summary, startedAt: round.startedAt, completedAt: new Date().toISOString() });
  // A stopped request keeps its work: the folder becomes a version without a build.
  // The branch session stays saved, so Continue resumes the same conversation.
  const stopped = async (summary: string | null) => {
    if (round.kind !== "request") return finish(round.id, { status: "interrupted", summary });
    try {
      const saved = await onBranch(round.sourceId, round.branch, () => saveBranchCheckpoint(round.sourceId, round.branch));
      append(round.id, { type: "build", status: "skipped", error: null, checkpointId: saved.id });
      await sidecar(saved.id, summary);
      return finish(round.id, { status: "interrupted", checkpointId: saved.id, summary });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return finish(round.id, { status: "interrupted", summary, error: `Stopped before the folder was valid, so no version was saved. The edits are still in the folder. ${reason}` });
    }
  };
  try {
    let input = { provider: round.provider, model: round.model, settings: round.settings, cwd: round.line.directory, resumeCursor: resume ? String(resume.resume_cursor) : null, prompt: round.prompt, attachments: round.attachments.filter(item => item.image).map(item => ({ path: item.path, mimeType: item.mimeType, name: item.name })), instructions: round.kind === "critique" ? critiqueInstructions : roundInstructions, permission: round.kind === "critique" ? "read-only" as const : "full" as const };
    for (let attempt = 0; ; attempt++) {
      const turn = await agentTurn(round.id, input, round.threadId);
      if (turn.status === "interrupted") return stopped(turn.summary);
      if (turn.status !== "completed") return finish(round.id, { status: turn.status, error: turn.error, summary: turn.summary });
      if (round.kind === "critique") {
        await sidecar(round.line.headId!, turn.summary);
        return finish(round.id, { status: "completed", checkpointId: round.line.headId, summary: turn.summary });
      }
      if (state.interrupted) return stopped(turn.summary);
      append(round.id, { type: "build", status: "started", error: null, checkpointId: null });
      try {
        const built = await onBranch(round.sourceId, round.branch, () => buildProjectArtifact(round.sourceId, { authorizeSourceExecution: true, branch: round.branch }));
        append(round.id, { type: "build", status: "completed", error: null, checkpointId: built.checkpoint.id });
        await sidecar(built.checkpoint.id, turn.summary);
        return finish(round.id, { status: "completed", checkpointId: built.checkpoint.id, summary: turn.summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Intake rounds legitimately stop before a plan exists. Keep their source as a checkpoint.
        if (message.includes("Project needs authoring")) {
          const saved = await onBranch(round.sourceId, round.branch, () => saveBranchCheckpoint(round.sourceId, round.branch));
          append(round.id, { type: "build", status: "skipped", error: null, checkpointId: saved.id });
          await sidecar(saved.id, turn.summary);
          return finish(round.id, { status: "completed", checkpointId: saved.id, summary: turn.summary });
        }
        append(round.id, { type: "build", status: "failed", error: message, checkpointId: null });
        if (attempt >= buildRetries || state.interrupted) return finish(round.id, { status: "failed", error: message, summary: turn.summary });
        const cursor = rounds().prepare("SELECT resume_cursor FROM thread_sessions WHERE thread_id=? AND provider=?").get(round.threadId, round.provider);
        const retry = `Studio's build failed after your turn:\n\n${message}\n\nFix the source so the build succeeds. Keep the requested change.`;
        append(round.id, { type: "retry", attempt: attempt + 1, prompt: retry });
        input = { ...input, resumeCursor: cursor ? String(cursor.resume_cursor) : input.resumeCursor, prompt: retry, attachments: [] };
      }
    }
  } catch (error) {
    finish(round.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

/** Files join the branch between rounds, never under an agent that is editing the folder. */
export async function addReferences({ data }: { data: { projectId: string; branch: string; files: File[] } }) {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  await branchLine(sourceId, data.branch);
  const { addReferences: add } = await import("@arch/project-tools/intake");
  const files = await Promise.all(data.files.map(async file => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
  const saved = await onBranch(sourceId, data.branch, () => add(sourceId, data.branch, files));
  return { checkpointId: saved.id };
}
/**
 * Start the next round where a stopped one left off: same agent, model and settings, same
 * session. The original request travels along in case the provider cannot resume it.
 */
export async function resumeRound({ data }: { data: { projectId: string; roundId: string } }) {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  const row = rounds().prepare("SELECT * FROM rounds WHERE id=? AND source_id=?").get(data.roundId, sourceId);
  if (!row || row.kind !== "request" || row.provider === null) throw new Error("Only a stopped request round can be continued.");
  const previous = summary(row);
  if (previous.status !== "interrupted" && previous.status !== "failed") throw new Error("Only a stopped request round can be continued.");
  const agent = rounds().prepare("SELECT settings FROM thread_agents WHERE thread_id=?").get(String(row.thread_id));
  const original = previous.request?.replace(/^Continue where you stopped\.[\s\S]*?Original request:\n\n/, "") ?? "";
  const request = `Continue where you stopped. The previous round ended before it finished, and its edits are still in the folder. Pick up from there.\n\nOriginal request:\n\n${original}`;
  return startRound({ data: { projectId: data.projectId, threadId: String(row.thread_id), kind: "request", request, provider: previous.provider!, model: previous.model!, settings: agent ? JSON.parse(String(agent.settings)) as Record<string, string | boolean> : {}, attachments: [] } });
}
export async function interruptRound({ data }: { data: { roundId: string } }) {
  requireStudio();
  const round = active.get(data.roundId);
  if (!round) throw new Error("This round is not running.");
  round.interrupted = true;
  await round.turn?.interrupt();
  return { interrupted: true };
}
export async function answerApproval({ data }: { data: { roundId: string; requestId: string; decision: "accept" | "decline" } }) {
  requireStudio();
  const round = active.get(data.roundId);
  if (!round?.turn) throw new Error("This round is not waiting for approval.");
  await round.turn.respond(data.requestId, data.decision);
  return { answered: true };
}

export function summary(row: Record<string, unknown>): RoundSummary {
  const running = active.has(String(row.id));
  // A round left running by a stopped Studio can never finish.
  const status = row.status === "running" && !running ? "interrupted" : String(row.status) as RoundSummary["status"];
  return { id: String(row.id), branch: String(row.branch), threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id), kind: String(row.kind) as RoundSummary["kind"], status, request: row.request === null ? null : String(row.request), attachments: JSON.parse(String(row.attachments)) as RoundAttachment[], provider: row.provider === null ? null : String(row.provider) as AgentProvider, model: row.model === null ? null : String(row.model), parentCheckpointId: row.parent_checkpoint_id === null ? null : String(row.parent_checkpoint_id), checkpointId: row.checkpoint_id === null ? null : String(row.checkpoint_id), summary: row.summary === null ? null : String(row.summary), error: row.error === null ? null : String(row.error), startedAt: String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at) };
}
export async function roundTimeline({ data }: { data: { projectId: string } }): Promise<RoundSummary[]> {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  const local = rounds().prepare("SELECT * FROM rounds WHERE source_id=? ORDER BY started_at").all(sourceId).map(summary);
  // Imported or exported rounds exist only as sidecars on this machine.
  const { projectRounds } = await import("@arch/project-tools");
  const known = new Set(local.map(round => round.id));
  // They join the oldest thread on their branch.
  const threadFor = (branch: string) => rounds().prepare("SELECT id FROM threads WHERE source_id=? AND branch=? AND archived_at IS NULL ORDER BY created_at LIMIT 1").get(sourceId, branch)?.id;
  const imported = (await projectRounds(sourceId)).filter(round => !known.has(round.id)).map(round => ({ ...round, threadId: threadFor(round.branch) === undefined ? null : String(threadFor(round.branch)), status: "completed" as const, error: null }));
  return [...local, ...imported].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export async function roundActivity({ data }: { data: { roundId: string; after: number } }): Promise<RoundActivity> {
  requireStudio();
  const row = rounds().prepare("SELECT * FROM rounds WHERE id=?").get(data.roundId);
  if (!row) throw new Error("Unknown round");
  const events = rounds().prepare("SELECT seq, event FROM round_events WHERE round_id=? AND seq>=? ORDER BY seq").all(data.roundId, data.after).map(item => JSON.parse(String(item.event)) as RoundEvent);
  return { round: summary(row), from: data.after, events };
}

export async function stopRounds() {
  for (const round of active.values()) round.interrupted = true;
  const { stopAgents } = await import("@arch/agent");
  await stopAgents();
}

/** Every thread in every project, with what the sidebar needs to group and label it. */
export async function threadList(): Promise<StudioThread[]> {
  requireStudio();
  const catalog = await localCatalog();
  const result: StudioThread[] = [];
  for (const project of catalog.projects) {
    const client = catalog.clients.find(item => item.id === project.clientId);
    if (!project.sourceId) continue;
    let lines: Awaited<ReturnType<typeof projectBranches>>;
    try { lines = await projectBranches(project.sourceId); } catch { continue; }
    // Each project keeps at least one thread on its primary branch.
    if (!rounds().prepare("SELECT 1 FROM threads WHERE source_id=? AND archived_at IS NULL").get(project.sourceId))
      rounds().prepare("INSERT INTO threads(id,source_id,branch,title,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), project.sourceId, lines.primary, "New thread", project.createdAt);
    const rows = rounds().prepare("SELECT * FROM threads WHERE source_id=? AND archived_at IS NULL").all(project.sourceId);
    for (const row of rows) {
      const id = String(row.id);
      const line = lines.branches.find(item => item.name === row.branch);
      const latest = rounds().prepare("SELECT * FROM rounds WHERE thread_id=? ORDER BY started_at DESC LIMIT 1").get(id);
      const latestRound = latest ? summary(latest) : null;
      const running = latestRound?.status === "running" ? latestRound : null;
      const agent = rounds().prepare("SELECT provider, model FROM thread_agents WHERE thread_id=?").get(id);
      const text = (value: unknown) => value === null || value === undefined ? null : String(value);
      result.push({
        id, projectId: project.id, projectName: project.name, clientId: project.clientId, clientName: client?.name ?? project.clientId,
        branch: String(row.branch), branchMissing: !line || line.archived, primary: lines.primary === row.branch, headId: line?.headId ?? null,
        title: String(row.title), createdAt: String(row.created_at),
        status: running ? (pendingApprovals(running.id) ? "approval" : "working") : latestRound?.status === "failed" ? "failed" : "ready",
        workingSince: running?.startedAt ?? null, latestRequestAt: latestRound?.startedAt ?? null, latestCompletedAt: latestRound?.completedAt ?? null,
        provider: agent ? String(agent.provider) as AgentProvider : null, model: agent ? String(agent.model) : null,
        settledOverride: text(row.settled_override) as StudioThread["settledOverride"], settledAt: text(row.settled_at),
        snoozedUntil: text(row.snoozed_until), snoozedAt: text(row.snoozed_at), lastVisitedAt: text(row.last_visited_at),
      });
    }
  }
  return result;
}
/** A new thread works on an existing branch folder, or forks a new branch from a saved version. */
export async function createThread({ data }: { data: { projectId: string; branch?: string; fromCheckpoint?: string } }) {
  requireStudio();
  const sourceId = await sourceOf(data.projectId);
  const lines = await projectBranches(sourceId);
  let branch = data.branch ?? lines.primary;
  if (data.fromCheckpoint) {
    // Variants get readable names: variant-2, variant-3, …
    const taken = new Set(lines.branches.map(item => item.name));
    let number = 2;
    while (taken.has(`variant-${number}`)) number++;
    const created = await createBranch(sourceId, { name: `variant-${number}`, from: data.fromCheckpoint });
    branch = created.name;
  } else await branchLine(sourceId, branch);
  const id = randomUUID();
  rounds().prepare("INSERT INTO threads(id,source_id,branch,title,created_at,last_visited_at) VALUES(?,?,?,?,?,?)").run(id, sourceId, branch, "New thread", new Date().toISOString(), new Date().toISOString());
  return { threadId: id, branch };
}
export type ThreadAction = { kind: "rename"; title: string } | { kind: "settle" } | { kind: "unsettle" } | { kind: "snooze"; until: string } | { kind: "unsnooze" } | { kind: "visit" } | { kind: "unread" } | { kind: "archive" };
export async function updateThread({ data }: { data: { projectId: string; threadId: string; action: ThreadAction } }) {
  requireStudio();
  requireThread(await sourceOf(data.projectId), data.threadId);
  const now = new Date().toISOString();
  const action = data.action;
  const run = (sql: string, ...values: (string | null)[]) => rounds().prepare(sql).run(...values, data.threadId);
  if (action.kind === "rename") run("UPDATE threads SET title=? WHERE id=?", action.title);
  else if (action.kind === "settle") run("UPDATE threads SET settled_override='settled', settled_at=?, snoozed_until=NULL, snoozed_at=NULL WHERE id=?", now);
  else if (action.kind === "unsettle") run("UPDATE threads SET settled_override='active', settled_at=NULL WHERE id=?");
  else if (action.kind === "snooze") run("UPDATE threads SET snoozed_until=?, snoozed_at=? WHERE id=?", action.until, now);
  else if (action.kind === "unsnooze") run("UPDATE threads SET snoozed_until=NULL, snoozed_at=NULL WHERE id=?");
  else if (action.kind === "visit") run("UPDATE threads SET last_visited_at=? WHERE id=?", now);
  // Unread means the latest completion is newer than the last visit.
  else if (action.kind === "unread") run("UPDATE threads SET last_visited_at='1970-01-01T00:00:00.000Z' WHERE id=?");
  else {
    if (activeThreads.has(data.threadId)) throw new Error("Stop the running round before archiving this thread.");
    run("UPDATE threads SET archived_at=? WHERE id=?", now);
  }
  return { updated: true };
}
