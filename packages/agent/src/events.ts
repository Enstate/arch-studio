import type { AgentEvent } from "./api.ts";
import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "./contracts/providerRuntime.ts";

export class TurnEvents {
  private readonly text = new Map<string, string>();
  private readonly resolved = new Set<string>();
  private finalAssistantMessage: string | null = null;
  private cursor: string | null = null;

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
