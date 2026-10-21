import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentEvent, AgentTurn, AgentTurnInput } from "./api.ts";
import { ApprovalRequestId, ProviderInstanceId, ThreadId } from "./contracts/index.ts";
import { EventQueue, TurnEvents } from "./events.ts";
import { ownAgent } from "./lifecycle.ts";
import type { ProviderAdapterError } from "./provider/Errors.ts";
import { makeClaudeAdapter } from "./provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "./provider/Layers/CodexAdapter.ts";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter.ts";
export { stopAgents } from "./lifecycle.ts";

type CompletedEvent = Extract<AgentEvent, { type: "completed" }>;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

async function requireTurnInput(input: AgentTurnInput): Promise<AgentTurnInput> {
  if (input.provider !== "claude" && input.provider !== "codex")
    throw new Error("Unknown agent provider.");
  if (input.permission !== "full" && input.permission !== "edit" && input.permission !== "read-only")
    throw new Error("Unknown agent permission.");
  if (!input.model?.trim() || typeof input.prompt !== "string" || !input.prompt.trim())
    throw new Error("A model and prompt are required.");
  if (input.settings !== undefined && (typeof input.settings !== "object" || input.settings === null || Object.values(input.settings).some((value) => typeof value !== "string" && typeof value !== "boolean")))
    throw new Error("Model settings must be strings or booleans.");
  if (typeof input.instructions !== "string" || !Array.isArray(input.attachments))
    throw new Error("Instructions and attachments are required.");
  if (
    input.resumeCursor !== null &&
    (typeof input.resumeCursor !== "string" || !input.resumeCursor.trim())
  )
    throw new Error("Invalid resume cursor.");
  if (
    input.provider === "claude" &&
    input.resumeCursor !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.resumeCursor,
    )
  )
    throw new Error("Invalid Claude session ID.");
  if (!isAbsolute(input.cwd)) throw new Error("Agent cwd must be absolute.");
  const cwd = await realpath(input.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Agent cwd must be a directory.");
  if (input.prompt.length > 120_000 || input.attachments.length > 8)
    throw new Error("The prompt or attachment count exceeds provider limits.");
  const attachments = await Promise.all(
    input.attachments.map(async (attachment) => {
      if (
        !isAbsolute(attachment.path) ||
        !IMAGE_MIME_TYPES.has(attachment.mimeType) ||
        typeof attachment.name !== "string"
      )
        throw new Error(
          "Attachments must be absolute image paths with a supported MIME type and name.",
        );
      const path = await realpath(attachment.path);
      const file = await stat(path);
      if (!file.isFile() || file.size > 10 * 1024 * 1024)
        throw new Error("Attachments must be image files no larger than 10 MiB.");
      await access(path, constants.R_OK);
      return { ...attachment, path };
    }),
  );
  return { ...input, cwd, attachments };
}

export async function startTurn(uncheckedInput: AgentTurnInput): Promise<AgentTurn> {
  const input = await requireTurnInput(uncheckedInput);
  const runtime = ManagedRuntime.make(NodeServices.layer);
  const queue = new EventQueue<AgentEvent>();
  const mapping = new TurnEvents();
  const threadId = ThreadId.make(randomUUID());
  const instanceId = ProviderInstanceId.make(input.provider === "claude" ? "claudeAgent" : "codex");
  const startup = new AbortController();
  const settings = Object.entries(input.settings ?? {}).map(([id, value]) => ({ id, value }));
  const modelSelection = { instanceId, model: input.model, ...(settings.length ? { options: settings } : {}) };
  // Ultrathink is a prompt keyword in Claude Code, not an API effort level.
  const prompt = input.provider === "claude" && input.settings?.effort === "ultrathink" ? `ultrathink\n\n${input.prompt}` : input.prompt;
  const pendingApprovals = new Map<string, boolean>();
  let adapter: ProviderAdapterShape<ProviderAdapterError> | undefined;
  let interrupted = false;
  let finished = false;
  let terminal: CompletedEvent | undefined;
  let resolveCompletion!: (value: CompletedEvent) => void;
  const completion = new Promise<CompletedEvent>((resolve) => {
    resolveCompletion = resolve;
  });
  let finishedWork!: Promise<void>;

  function finish(event: CompletedEvent): void {
    if (terminal) return;
    terminal = event;
    resolveCompletion(event);
  }
  function emit(event: AgentEvent): void {
    if (terminal && event.type !== "approval-resolved") return;
    if (event.type === "completed") {
      finish(event);
      return;
    }
    if (event.type === "approval") pendingApprovals.set(event.requestId, false);
    if (event.type === "approval-resolved") pendingApprovals.delete(event.requestId);
    queue.push(event);
  }
  async function interrupt(): Promise<void> {
    if (finished) return;
    interrupted = true;
    finish(mapping.completed("interrupted", null));
    startup.abort();
    // Scope disposal also releases approval waiters and kills subprocesses.
    if (adapter)
      await runtime
        .runPromise(adapter.interruptTurn(threadId).pipe(Effect.timeout("2 seconds")))
        .catch(() => {});
    await finishedWork;
  }
  const release = ownAgent(interrupt);

  finishedWork = (async () => {
    const scope = await Effect.runPromise(Scope.make());
    let eventFiber: Fiber.Fiber<void, never> | undefined;
    try {
      const makeAdapter: Effect.Effect<
        ProviderAdapterShape<ProviderAdapterError>,
        never,
        NodeServices.NodeServices | Scope.Scope
      > = input.provider === "claude"
        ? makeClaudeAdapter({ binaryPath: "claude", launchArgs: "" })
        : makeCodexAdapter({ binaryPath: "codex", launchArgs: "" });
      const activeAdapter = await runtime.runPromise(
        makeAdapter.pipe(Effect.provideService(Scope.Scope, scope)),
        { signal: startup.signal },
      );
      adapter = activeAdapter;
      eventFiber = runtime.runFork(
        Stream.runForEach(activeAdapter.streamEvents, (event) =>
          Effect.gen(function* () {
            if (event.type === "user-input.requested" && event.requestId) {
              // The API deliberately has no conversational answer channel.
              yield* activeAdapter.respondToUserInput(
                threadId,
                ApprovalRequestId.make(event.requestId),
                {},
              );
              return;
            }
            for (const mapped of mapping.accept(event)) emit(mapped);
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              finish(
                mapping.completed(
                  interrupted ? "interrupted" : "failed",
                  Cause.pretty(cause),
                ),
              );
            }),
          ),
        ),
      );
      const session = await runtime.runPromise(
        activeAdapter
          .startSession({
            threadId,
            cwd: input.cwd,
            modelSelection,
            runtimeMode: input.permission === "full" ? "full-access" : input.permission === "edit" ? "auto-accept-edits" : "approval-required",
            instructions: input.instructions,
            ...(input.resumeCursor
              ? {
                  resumeCursor:
                    input.provider === "claude"
                      ? { resume: input.resumeCursor }
                      : { threadId: input.resumeCursor },
                }
              : {}),
          })
          .pipe(Effect.timeout("60 seconds")),
        { signal: startup.signal },
      );
      const cursor = session.resumeCursor as
        | { resume?: string; sessionId?: string; threadId?: string }
        | undefined;
      const resumeCursor =
        input.provider === "claude" ? (cursor?.resume ?? cursor?.sessionId) : cursor?.threadId;
      if (resumeCursor) for (const event of mapping.session(resumeCursor)) emit(event);
      if (!interrupted)
        await runtime.runPromise(
          activeAdapter.sendTurn({
            threadId,
            input: prompt,
            attachments: input.attachments.map((attachment) => ({
              ...attachment,
              type: "image" as const,
            })),
            modelSelection,
          }),
          { signal: startup.signal },
        );
      await completion;
    } catch (error) {
      finish(
        mapping.completed(
          interrupted ? "interrupted" : "failed",
          interrupted ? null : error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      // Keep completion behind cleanup so consuming the stream never leaves a child running.
      let cleanupError: unknown;
      try {
        await runtime.runPromise(Scope.close(scope, Exit.void));
      } catch (error) {
        cleanupError = error;
      }
      try {
        if (eventFiber) await runtime.runPromise(Fiber.interrupt(eventFiber));
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await runtime.dispose();
      } catch (error) {
        cleanupError ??= error;
      }
      for (const requestId of pendingApprovals.keys())
        for (const event of mapping.resolvedApproval(requestId, "decline")) queue.push(event);
      pendingApprovals.clear();
      if (cleanupError)
        terminal = mapping.completed(
          "failed",
          `Agent cleanup failed: ${String(cleanupError)}`,
        );
      queue.push(
        terminal ??
          mapping.completed(
            interrupted ? "interrupted" : "failed",
            "Agent stream ended without a result.",
          ),
      );
      queue.close();
      finished = true;
      release();
    }
  })();

  return {
    events: queue,
    interrupt,
    async respond(requestId, decision) {
      if (decision !== "accept" && decision !== "decline")
        throw new Error("Unknown approval decision.");
      if (finished || terminal || !adapter || !pendingApprovals.has(requestId) || pendingApprovals.get(requestId))
        throw new Error(`Approval is no longer pending: ${requestId}`);
      pendingApprovals.set(requestId, true);
      try {
        await runtime.runPromise(
          adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId), decision),
        );
        for (const event of mapping.resolvedApproval(requestId, decision)) emit(event);
        pendingApprovals.delete(requestId);
      } catch (error) {
        if (pendingApprovals.has(requestId)) pendingApprovals.set(requestId, false);
        throw error;
      }
    },
  };
}
