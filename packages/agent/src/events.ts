import type { AgentEvent } from "./api.ts";
import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "./contracts/providerRuntime.ts";

export class TurnEvents {
  private readonly text = new Map<string, string>();
  private readonly resolved = new Set<string>();
  private finalAssistantMessage: string | null = null;
  private cursor: string | null = null;
  private limited = false;

  session(cursor: string): AgentEvent[] {
    if (cursor === this.cursor) return [];
    this.cursor = cursor;
    return [{ type: "session", resumeCursor: cursor }];
  }

  completed(
    status: "completed" | "failed" | "interrupted",
    error: string | null,
  ): Extract<AgentEvent, { type: "completed" }> {
    return {
      type: "completed",
      status,
      error,
      summary: this.finalAssistantMessage,
    };
  }

  resolvedApproval(requestId: string, decision: "accept" | "decline"): AgentEvent[] {
    if (this.resolved.has(requestId)) return [];
    this.resolved.add(requestId);
    return [{ type: "approval-resolved", requestId, decision }];
  }

  answeredQuestion(requestId: string, answers: Record<string, string>): AgentEvent[] {
    if (this.resolved.has(requestId)) return [];
    this.resolved.add(requestId);
    return [{ type: "question-answered", requestId, answers }];
  }

  accept(event: ProviderRuntimeEvent): AgentEvent[] {
    const itemId =
      event.itemId ?? event.providerRefs?.providerItemId ?? event.turnId ?? event.threadId;
    switch (event.type) {
      case "thread.started":
        return event.payload.providerThreadId ? this.session(event.payload.providerThreadId) : [];
      case "content.delta": {
        if (event.payload.streamKind !== "assistant_text") return [];
        this.text.set(itemId, (this.text.get(itemId) ?? "") + event.payload.delta);
        return [{ type: "text", itemId, delta: event.payload.delta }];
      }
      case "item.started":
      case "item.completed": {
        if (event.payload.itemType === "assistant_message" && event.type === "item.completed") {
          const completeText = event.payload.detail ?? this.text.get(itemId);
          if (completeText !== undefined) this.finalAssistantMessage = completeText;
          // Providers may omit partial messages. Emit their final text once.
          if (!this.text.has(itemId) && completeText) {
            this.text.set(itemId, completeText);
            return [{ type: "text", itemId, delta: completeText }];
          }
          return [];
        }
        if (!isToolLifecycleItemType(event.payload.itemType)) return [];
        return [
          {
            type: "tool",
            itemId,
            status:
              event.type === "item.started"
                ? "started"
                : event.payload.status === "failed" || event.payload.status === "declined"
                  ? "failed"
                  : "completed",
            title: event.payload.title ?? "Tool call",
            detail: event.payload.detail ?? null,
          },
        ];
      }
      case "request.opened": {
        if (!event.requestId) return [];
        const type = event.payload.requestType;
        const kind =
          type === "command_execution_approval" || type === "exec_command_approval"
            ? "command"
            : type === "file_change_approval" || type === "apply_patch_approval"
              ? "file-change"
              : type === "file_read_approval"
                ? "file-read"
                : "other";
        const title =
          kind === "command"
            ? "Run command"
            : kind === "file-change"
              ? "Change files"
              : kind === "file-read"
                ? "Read files"
                : "Use tool";
        return [
          {
            type: "approval",
            requestId: event.requestId,
            kind,
            title,
            detail: event.payload.detail ?? null,
          },
        ];
      }
      case "request.resolved":
        return event.requestId && event.payload.decision
          ? this.resolvedApproval(
              event.requestId,
              event.payload.decision === "accept" || event.payload.decision === "acceptForSession"
                ? "accept"
                : "decline",
            )
          : [];
      case "user-input.requested":
        return event.requestId
          ? [
              {
                type: "question",
                requestId: event.requestId,
                questions: event.payload.questions.map((question) => ({
                  id: question.id,
                  header: question.header,
                  question: question.question,
                  options: question.options.map((option) => ({ label: option.label, description: option.description })),
                  multiSelect: question.multiSelect ?? false,
                })),
              },
            ]
          : [];
      case "user-input.resolved":
        return event.requestId
          ? this.answeredQuestion(
              event.requestId,
              Object.fromEntries(
                Object.entries(event.payload.answers).flatMap(([id, value]) => {
                  const text = answerText(value);
                  return text === null ? [] : [[id, text]];
                }),
              ),
            )
          : [];
      case "runtime.error": {
        if (this.limited || !codexUsageLimitFailure(event.payload.detail)) return [];
        this.limited = true;
        return [{ type: "limit", resetsAt: null }];
      }
      case "account.rate-limits.updated": {
        if (this.limited) return [];
        const limit = planLimit(event.payload.rateLimits);
        if (!limit) return [];
        this.limited = true;
        return [{ type: "limit", resetsAt: limit.resetsAt }];
      }
      case "turn.completed":
        if (event.payload.summary !== undefined) this.finalAssistantMessage = event.payload.summary;
        return [
          this.completed(
            event.payload.state === "cancelled" ? "interrupted" : event.payload.state,
            event.payload.errorMessage ?? null,
          ),
        ];
      case "turn.aborted":
        return [this.completed("interrupted", event.payload.reason ?? null)];
      case "session.exited":
        return [
          this.completed(
            "failed",
            event.payload.reason ?? "Provider process exited before completing this round.",
          ),
        ];
      default:
        return [];
    }
  }
}

/** Claude answers are strings; Codex wraps them as `{ answers: [...] }`. */
function answerText(value: unknown): string | null {
  if (typeof value === "string") return value;
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { answers?: unknown }).answers)
      ? (value as { answers: unknown[] }).answers
      : null;
  return list ? list.filter((entry): entry is string => typeof entry === "string").join(", ") : null;
}

const resetTime = (seconds: unknown) =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds < 8.64e12
    ? new Date(seconds * 1000).toISOString()
    : null;
/**
 * The plan limit that stops the agent, from Claude's `rate_limit_event` or Codex's rate-limit
 * snapshot. Warnings and limits covered by overage credits are not stops.
 */
export function planLimit(rateLimits: unknown): { resetsAt: string | null } | null {
  if (typeof rateLimits !== "object" || rateLimits === null) return null;
  const claude = (rateLimits as { rate_limit_info?: unknown }).rate_limit_info;
  if (typeof claude === "object" && claude !== null) {
    const info = claude as { status?: unknown; resetsAt?: unknown; overageStatus?: unknown; isUsingOverage?: unknown };
    if (info.status !== "rejected" || info.isUsingOverage === true) return null;
    if (info.overageStatus === "allowed" || info.overageStatus === "allowed_warning") return null;
    return { resetsAt: resetTime(info.resetsAt) };
  }
  const codex = rateLimits as { rateLimitReachedType?: unknown; primary?: unknown; secondary?: unknown };
  const windows = [codex.primary, codex.secondary].filter(
    (window): window is { usedPercent: number; resetsAt?: unknown } =>
      typeof window === "object" && window !== null && typeof (window as { usedPercent?: unknown }).usedPercent === "number",
  );
  const full = windows.filter((window) => window.usedPercent >= 100);
  if (!full.length && !codex.rateLimitReachedType) return null;
  const resets = full.map((window) => resetTime(window.resetsAt)).filter((value): value is string => value !== null).sort();
  return { resetsAt: resets.at(-1) ?? null };
}

/**
 * A Codex turn error the plan limit caused, from T3 Code's CodexAdapterV2 codexUsageLimitError:
 * usageLimitExceeded, rateLimitExceeded, or retries that ran out on HTTP 429.
 */
export function codexUsageLimitFailure(detail: unknown): boolean {
  const info = (detail as { error?: { codexErrorInfo?: unknown } } | null | undefined)?.error?.codexErrorInfo;
  const code = typeof info === "string" ? info : typeof info === "object" && info !== null ? Object.keys(info)[0] : undefined;
  const exhausted = typeof info === "object" && info !== null && "responseTooManyFailedAttempts" in info
    ? (info as { responseTooManyFailedAttempts?: { httpStatusCode?: unknown } }).responseTooManyFailedAttempts?.httpStatusCode
    : undefined;
  return code === "usageLimitExceeded" || code === "rateLimitExceeded" || exhausted === 429;
}

/** A single-consumer stream. It also buffers provider startup events. */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | undefined;
  private ended = false;
  private consumed = false;

  push(value: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
    } else this.buffer.push(value);
  }

  close(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) throw new Error("Agent events can only be consumed once.");
    this.consumed = true;
    return {
      next: () => {
        if (this.buffer.length)
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
