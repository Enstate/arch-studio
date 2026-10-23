import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ProjectFileError, studioStoreDirectory } from "@arch/project-tools";
import { failureCode, redactDiagnostics } from "./diagnostics";

/** The log rotates past this size, keeping one previous file. */
export const studioLogBytes = 1024 * 1024;
/** A query polling a broken project fails every few seconds. One line per window is enough. */
const repeatWindow = 10 * 60 * 1000;
export const studioLogFile = () => path.join(studioStoreDirectory(), "logs", "studio.log");

/**
 * The error a server function reports to the browser. A project file problem travels as its
 * code, file and fields, so Studio can say which file to fix in the person's language.
 */
export function reportedFailure(error: unknown): unknown {
  if (error instanceof ProjectFileError) return new Error(JSON.stringify({ code: "ARCH_PROJECT_FILE", file: error.file, issues: error.issues }));
  return error;
}

/**
 * One JSON line for a failure: when, where, its code, message and a short stack. It never
 * holds request bodies or file contents, and URLs, tokens and the home folder are redacted.
 */
export function studioLogLine(source: string, error: unknown, extra: { round?: string } = {}, at = new Date(), home = homedir()) {
  const message = error instanceof Error ? error.message : String(error);
  const errno = (error as { code?: unknown } | null)?.code;
  const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(1, 13).join("\n") : "";
  return `${JSON.stringify({
    time: at.toISOString(), source: source.slice(0, 120), ...extra,
    code: error instanceof ProjectFileError ? "ARCH_PROJECT_FILE" : failureCode(message) ?? (typeof errno === "string" ? errno.slice(0, 40) : null),
    name: error instanceof Error ? error.name.slice(0, 80) : typeof error,
    message: redactDiagnostics(message, home).slice(0, 4000),
    ...(stack && { stack: redactDiagnostics(stack, home).slice(0, 4000) }),
  })}\n`;
}

/** Append a line, first moving a full log to `studio.log.1`. */
export async function appendStudioLog(file: string, line: string, limit = studioLogBytes) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const size = await fs.stat(file).then(stat => stat.size, () => 0);
  if (size > 0 && size + Buffer.byteLength(line) > limit) await fs.rename(file, `${file}.1`);
  await fs.appendFile(file, line, { mode: 0o600 });
}

// Writes queue on the process so rotation never races, across development reloads too.
const processState = globalThis as typeof globalThis & { archStudioLog?: { pending: Promise<void>; recent: Map<string, number> } };
const log = processState.archStudioLog ??= { pending: Promise.resolve(), recent: new Map() };
/** Record a server-side failure in `<store>/logs/studio.log`. Logging never fails the caller. */
export function recordFailure(source: string, error: unknown, extra: { round?: string } = {}): Promise<void> {
  let line: string;
  try { line = studioLogLine(source, error, extra); } catch { return log.pending; }
  const parsed = JSON.parse(line) as { code: string | null; message: string };
  const key = `${source}\n${extra.round ?? ""}\n${parsed.code}\n${parsed.message}`;
  const now = Date.now();
  if (now - (log.recent.get(key) ?? -Infinity) < repeatWindow) return log.pending;
  log.recent.delete(key); log.recent.set(key, now);
  if (log.recent.size > 200) log.recent.delete(log.recent.keys().next().value!);
  log.pending = log.pending.then(() => appendStudioLog(studioLogFile(), line)).catch(() => undefined);
  return log.pending;
}
