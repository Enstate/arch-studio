import { constants, promises as fs } from "node:fs";
import { homedir, release } from "node:os";
import path from "node:path";
import type { AgentProviderStatus } from "@arch/agent";
import { inspectProject, listProjects, projectBranches, writeArchive, type ArchiveEntry } from "@arch/project-tools";
import { redactDiagnostics } from "./diagnostics";
import { requireStudio } from "./local-session";
import { offerDownload } from "./project-package.server";
import { agentProviders, rounds } from "./rounds.server";
import { studioLogFile } from "./studio-log.server";

/** The only files a report takes from a project folder. References, assets, outputs and images never travel. */
const projectFiles = ["arch.project.json", "arch.context.json", "package.json"] as const;
const projectFileBytes = 256 * 1024;
const logBytes = 2 * 1024 * 1024;
const failedRounds = 10;
const roundEvents = 30;
const eventText = 1000;

/** A file's text up to `limit` bytes, or null when it is missing. Links are never followed. */
async function boundedText(file: string, limit: number): Promise<string | null> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8") + (stat.size > limit ? "\n[truncated]" : "");
  } finally { await handle.close(); }
}

/** A round event without session cursors, image blobs or long text. */
function eventSummary(serialized: string): unknown {
  let event: Record<string, unknown>;
  try { event = JSON.parse(serialized) as Record<string, unknown>; } catch { return { type: "unreadable" }; }
  if (event.type === "session" || event.type === "image") return { type: event.type };
  return Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === "string" && value.length > eventText ? `${value.slice(0, eventText)}…` : value]));
}

/** Failed rounds of a project with their error text and last events. Requests and attachments stay out. */
function failedRoundsOf(sourceId: string) {
  const database = rounds();
  const events = database.prepare("SELECT event FROM round_events WHERE round_id=? ORDER BY seq DESC LIMIT ?");
  return database.prepare("SELECT id, branch, kind, status, provider, model, error, started_at, completed_at FROM rounds WHERE source_id=? AND (status='failed' OR error IS NOT NULL) ORDER BY started_at DESC LIMIT ?").all(sourceId, failedRounds).map(row => ({
    id: String(row.id), branch: String(row.branch), kind: String(row.kind), status: String(row.status), provider: row.provider === null ? null : String(row.provider), model: row.model === null ? null : String(row.model),
    startedAt: String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at),
    error: row.error === null ? null : String(row.error).slice(0, 8000),
    lastEvents: events.all(String(row.id), roundEvents).reverse().map(item => eventSummary(String(item.event))),
  }));
}

/**
 * Everything a problem report holds, as ZIP entries. Every text passes the same redaction as
 * the log, so this machine's home folder reads as `~` and URLs and tokens are gone.
 */
export async function problemReportEntries({ appVersion, providers, home = homedir(), at = new Date() }: { appVersion: string | null; providers: AgentProviderStatus[] | null; home?: string; at?: Date }): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const text = (name: string, value: string) => entries.push({ name, text: redactDiagnostics(value, home) });
  const json = (name: string, value: unknown) => text(name, `${JSON.stringify(value, null, 2)}\n`);
  json("report.json", {
    createdAt: at.toISOString(), appVersion, platform: process.platform, arch: process.arch, osRelease: release(),
    bun: process.versions.bun ?? null, node: process.versions.node,
    // Status only. Accounts, emails and program paths stay on this computer.
    agents: providers?.map(status => ({ provider: status.provider, installed: status.installed, authenticated: status.authenticated, version: status.version, issue: status.issue, warnings: status.warnings, checkedAt: status.checkedAt })) ?? null,
  });
  for (const file of [studioLogFile(), `${studioLogFile()}.1`]) {
    const content = await boundedText(file, logBytes);
    if (content !== null) text(`logs/${path.basename(file)}`, content);
  }
  for (const source of await listProjects()) {
    const prefix = `projects/${source.manifest.id}`;
    try {
      const lines = await projectBranches(source.manifest.id);
      for (const line of lines.branches) for (const name of projectFiles) {
        const content = await boundedText(path.join(line.directory, name), projectFileBytes);
        if (content !== null) text(`${prefix}/${line.name}/${name}`, content);
      }
      const inspection = await inspectProject(source.manifest.id);
      json(`${prefix}/versions.json`, {
        primary: lines.primary,
        branches: lines.branches.map(line => ({ name: line.name, headId: line.headId, forkedFrom: line.forkedFrom, createdAt: line.createdAt, archived: line.archived })),
        checkpoints: inspection.checkpoints.map(checkpoint => ({ id: checkpoint.id, parentId: checkpoint.parentId, createdAt: checkpoint.createdAt })),
      });
    } catch (error) { text(`${prefix}/error.txt`, error instanceof Error ? error.message : String(error)); }
    json(`${prefix}/failed-rounds.json`, failedRoundsOf(source.manifest.id));
  }
  return entries;
}

/** One ZIP the person can attach to an email or a message. Nothing is sent from here. */
export async function problemReport({ data }: { data: { appVersion: string | null } }) {
  const origin = requireStudio();
  const providers = await agentProviders({ data: { refresh: false } }).catch(() => null);
  const at = new Date();
  const entries = await problemReportEntries({ appVersion: data.appVersion, providers, at });
  return offerDownload(origin, `arch-problem-report-${at.toISOString().slice(0, 10)}.zip`, file => writeArchive(file, entries, at));
}
