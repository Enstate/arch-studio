export type AgentProvider = "claude" | "codex";
/** full: no prompts and no sandbox. edit: sandboxed, edits in the folder. read-only: no writes. */
export type AgentPermission = "full" | "edit" | "read-only";
export type AgentAttachment = { path: string; mimeType: string; name: string };
export type AgentModelOption = { id: string; label: string; isDefault?: boolean; description?: string };
/** A setting a model accepts per turn, such as reasoning effort or fast mode. */
export type AgentModelSetting =
  | { id: string; label: string; type: "select"; options: AgentModelOption[] }
  | { id: string; label: string; type: "boolean"; currentValue?: boolean };
export type AgentModel = { id: string; label: string; legacy: boolean; settings: AgentModelSetting[] };
export type AgentProviderStatus = {
  provider: AgentProvider;
  installed: boolean;
  authenticated: boolean | null;
  version: string | null;
  models: AgentModel[];
  message: string | null;
};
export type AgentTurnInput = {
  provider: AgentProvider;
  model: string;
  cwd: string;
  resumeCursor: string | null;
  prompt: string;
  attachments: AgentAttachment[];
  instructions: string;
  permission: AgentPermission;
  /** Values for the model's settings, keyed by setting id. Omitted settings use defaults. */
  settings?: Record<string, string | boolean>;
};
export type AgentEvent =
  | { type: "session"; resumeCursor: string }
  | { type: "text"; itemId: string; delta: string }
  | {
      type: "tool";
      itemId: string;
      status: "started" | "completed" | "failed";
      title: string;
      detail: string | null;
    }
  | {
      type: "approval";
      requestId: string;
      kind: "command" | "file-change" | "file-read" | "other";
      title: string;
      detail: string | null;
    }
  | {
      type: "approval-resolved";
      requestId: string;
      decision: "accept" | "decline";
    }
  | {
      type: "completed";
      status: "completed" | "failed" | "interrupted";
      error: string | null;
      summary: string | null;
    };
export type AgentTurn = {
  events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  respond(requestId: string, decision: "accept" | "decline"): Promise<void>;
};
