import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../src/index.ts";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
} from "../src/contracts/index.ts";
import { EventQueue, TurnEvents, planLimit } from "../src/events.ts";
import { makeClaudeAdapter } from "../src/provider/Layers/ClaudeAdapter.ts";
import { buildTurnStartParams } from "../src/provider/Layers/CodexSessionRuntime.ts";
import { claudeToolPermission } from "../src/provider/permissions.ts";

test("one round preserves text, approvals and sandbox boundaries and closes its mock provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "arch-agent-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(root, "outside.txt"), "private");
  await symlink(root, join(cwd, "escape"));
  const runtime = ManagedRuntime.make(NodeServices.layer);
  const scope = await runtime.runPromise(Scope.make());
  const sdkEvents = new EventQueue<SDKMessage>();
  let options!: Options;
  let closed = 0;
  let interrupted = 0;
  let reader: Fiber.Fiber<void, never> | undefined;
  try {
    expect(
      await claudeToolPermission(cwd, "auto-accept-edits", "Write", {
        file_path: "new.ts",
      }),
    ).toBe("allow");
    expect(
      await claudeToolPermission(cwd, "auto-accept-edits", "Read", {
        file_path: "escape/outside.txt",
      }),
    ).toBe("ask");
    expect(
      await claudeToolPermission(cwd, "auto-accept-edits", "Write", {
        file_path: "../outside.txt",
      }),
    ).toBe("ask");
    expect(
      await claudeToolPermission(cwd, "approval-required", "MultiEdit", {
        file_path: "new.ts",
      }),
    ).toBe("deny");
    expect(
      await claudeToolPermission(cwd, "approval-required", "Read", {
        file_path: "new.ts",
      }),
    ).toBe("allow");
    expect(
      await claudeToolPermission(cwd, "auto-accept-edits", "WebSearch", {
        query: "houses",
      }),
    ).toBe("ask");
    expect(await claudeToolPermission(cwd, "auto-accept-edits", "Read", { file_path: "~/.claude/settings.json" })).toBe("ask");
    expect(await claudeToolPermission(cwd, "auto-accept-edits", "Bash", { command: "ls" })).toBe("allow");
    expect(await claudeToolPermission(cwd, "approval-required", "Bash", { command: "ls" })).toBe("ask");
    expect(await claudeToolPermission(cwd, "full-access", "Read", { file_path: "/tmp/outside.png" })).toBe("allow");
    expect(await claudeToolPermission(cwd, "full-access", "WebFetch", { url: "https://example.com" })).toBe("allow");
    const edit = await Effect.runPromise(
      buildTurnStartParams({
        threadId: "native",
        cwd,
        runtimeMode: "auto-accept-edits",
        prompt: "round",
      }),
    );
    expect(edit.approvalPolicy).toBe("on-request");
    expect(edit.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    const read = await Effect.runPromise(
      buildTurnStartParams({
        threadId: "native",
        cwd,
        runtimeMode: "approval-required",
        prompt: "round",
      }),
    );
    expect(read.sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false,
    });

    const mapping = new TurnEvents();
    const base = {
      eventId: EventId.make("event"),
      threadId: ThreadId.make("thread"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: new Date().toISOString(),
    };
    const itemId = RuntimeItemId.make("message");
    expect(mapping.session("native")).toEqual([{ type: "session", resumeCursor: "native" }]);
    expect(mapping.session("native")).toEqual([]);
    expect(
      mapping.accept({
        ...base,
        type: "content.delta",
        itemId,
        payload: { streamKind: "reasoning_text", delta: "private" },
      }),
    ).toEqual([]);
    expect(
      mapping.accept({
        ...base,
        type: "content.delta",
        itemId,
        payload: { streamKind: "assistant_text", delta: "Done" },
      }),
    ).toEqual([{ type: "text", itemId: "message", delta: "Done" }]);
    expect(
      mapping.accept({
        ...base,
        type: "item.completed",
        itemId,
        payload: { itemType: "assistant_message", detail: "Done" },
      }),
    ).toEqual([]);
    expect(
      mapping.accept({
        ...base,
        type: "turn.completed",
        payload: { state: "completed" },
      }),
    ).toEqual([{ type: "completed", status: "completed", error: null, summary: "Done" }]);
    expect(
      mapping.accept({
        ...base,
        type: "turn.completed",
        payload: { state: "completed", summary: "Final assistant message" },
      })[0],
    ).toMatchObject({ summary: "Final assistant message" });
    const requestId = RuntimeRequestId.make("approval");
    expect(
      mapping.accept({
        ...base,
        type: "request.opened",
        requestId,
        payload: { requestType: "file_read_approval", detail: "outside.txt" },
      })[0],
    ).toMatchObject({ type: "approval", kind: "file-read" });
    expect(mapping.resolvedApproval(requestId, "accept")).toEqual([
      { type: "approval-resolved", requestId: "approval", decision: "accept" },
    ]);
    expect(
      mapping.accept({
        ...base,
        type: "request.resolved",
        requestId,
        payload: { requestType: "file_read_approval", decision: "accept" },
      }),
    ).toEqual([]);
    expect(
      mapping.accept({
        ...base,
        type: "item.completed",
        itemId,
        payload: {
          itemType: "command_execution",
          status: "failed",
          title: "Command run",
        },
      })[0],
    ).toMatchObject({ type: "tool", status: "failed" });
    expect(
      mapping.accept({
        ...base,
        type: "turn.completed",
        payload: { state: "cancelled" },
      })[0],
    ).toMatchObject({ type: "completed", status: "interrupted" });

    // Exercise the retained adapter's real Deferred approval path with an in-memory SDK.
    const adapter = await runtime.runPromise(
      makeClaudeAdapter(
        { binaryPath: "claude", launchArgs: "" },
        {
          createQuery(input) {
            options = input.options;
            return {
              [Symbol.asyncIterator]: () => sdkEvents[Symbol.asyncIterator](),
              async interrupt() {
                interrupted++;
              },
              async setModel() {},
              async setPermissionMode() {},
              async setMaxThinkingTokens() {},
              close() {
                closed++;
                sdkEvents.close();
              },
            };
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const threadId = ThreadId.make("mock-thread");
    const seen: AgentEvent[] = [];
    const approvals = new TurnEvents();
    reader = runtime.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          seen.push(...approvals.accept(event));
          if (event.type === "request.opened" && event.requestId)
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(event.requestId),
              "accept",
            );
        }),
      ),
    );
    const session = await runtime.runPromise(
      adapter.startSession({
        threadId,
        cwd,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "sonnet",
        },
        runtimeMode: "auto-accept-edits",
        instructions: "Use project references.",
      }),
    );
    expect(session.resumeCursor).toHaveProperty("resume");
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Use project references.",
    });
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
    // Shell commands run without prompts only inside a sandbox they cannot leave.
    expect(options.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
    const result = await options.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: "PreToolUse",
        session_id: "mock",
        transcript_path: "",
        cwd,
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com", prompt: "Read it" },
        tool_use_id: "tool",
      },
      "tool",
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(seen.some((event) => event.type === "approval")).toBe(true);
    await runtime.runPromise(adapter.interruptTurn(threadId));
    expect(interrupted).toBe(1);
    await runtime.runPromise(Scope.close(scope, Exit.void));
    expect(closed).toBe(1);
  } finally {
    await runtime.runPromise(Scope.close(scope, Exit.void));
    if (reader) await runtime.runPromise(Fiber.interrupt(reader));
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent questions reach the person once, and plan limits say when they reset", () => {
  const mapping = new TurnEvents();
  const base = {
    eventId: EventId.make("event"),
    threadId: ThreadId.make("thread"),
    provider: ProviderDriverKind.make("claudeAgent"),
    createdAt: new Date().toISOString(),
  };
  const requestId = RuntimeRequestId.make("question");
  const question = { id: "How many storeys?", header: "Storeys", question: "How many storeys?", options: [{ label: "2", description: "Two" }], multiSelect: false };
  expect(mapping.accept({ ...base, type: "user-input.requested", requestId, payload: { questions: [question] } })).toEqual([
    { type: "question", requestId: "question", questions: [question] },
  ]);
  // Codex wraps answers as lists; both read as text.
  expect(mapping.accept({ ...base, type: "user-input.resolved", requestId, payload: { answers: { "How many storeys?": { answers: ["2", "basement"] } } } })).toEqual([
    { type: "question-answered", requestId: "question", answers: { "How many storeys?": "2, basement" } },
  ]);
  expect(mapping.answeredQuestion("question", {})).toEqual([]);

  expect(planLimit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1_900_000_000 } })).toBeNull();
  expect(planLimit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000, overageStatus: "allowed" } })).toBeNull();
  expect(planLimit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000 } })).toEqual({ resetsAt: "2030-03-17T17:46:40.000Z" });
  expect(planLimit({ primary: { usedPercent: 40, resetsAt: 1_900_000_000 } })).toBeNull();
  expect(planLimit({ primary: { usedPercent: 100, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 20 } })).toEqual({ resetsAt: "2030-03-17T17:46:40.000Z" });
  const limit = { ...base, type: "account.rate-limits.updated" as const, payload: { rateLimits: { rate_limit_info: { status: "rejected" } } } };
  expect(mapping.accept(limit)).toEqual([{ type: "limit", resetsAt: null }]);
  expect(mapping.accept(limit)).toEqual([]);
});
