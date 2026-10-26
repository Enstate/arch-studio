export type AgentProvider = "claude" | "codex";
/** full: no prompts and no sandbox. edit: sandboxed, edits in the folder. read-only: no writes. */
export type AgentPermission = "full" | "edit" | "read-only";
export type AgentAttachment = { path: string; mimeType: string; name: string };
/** An MCP server the agent reaches over streamable HTTP for the turn, such as Studio's own on loopback. */
export type AgentMcpServer = { url: string };
export type AgentModelOption = { id: string; label: string; isDefault?: boolean; description?: string };
/** A setting a model accepts per turn, such as reasoning effort or fast mode. */
export type AgentModelSetting =
  | { id: string; label: string; type: "select"; options: AgentModelOption[] }
  | { id: string; label: string; type: "boolean"; currentValue?: boolean };
export type AgentModel = { id: string; label: string; legacy: boolean; settings: AgentModelSetting[] };
/** How the local CLI signs in. Plans keep the provider's own IDs, such as "max" or "plus". */
export type AgentAccount =
  | { kind: "subscription"; plan: string | null; email: string | null }
  | { kind: "api-key" }
  | { kind: "cloud"; service: string };
/**
 * Why a provider can't run. not-installed: no CLI on PATH. launcher-only: a Windows
 * launcher without its native executable. signed-out: the CLI reports no login.
 * unverified: sign-in could not be confirmed. failed: the CLI did not respond.
 */
export type AgentProviderIssue = "not-installed" | "launcher-only" | "signed-out" | "unverified" | "failed";
/** git-bash-missing: Claude Code on Windows runs shell commands through Git Bash. */
export type AgentProviderWarning = "git-bash-missing";
export type AgentProviderStatus = {
  provider: AgentProvider;
  installed: boolean;
  authenticated: boolean | null;
  version: string | null;
  /** The resolved CLI file, shown so people can tell which install Studio uses. */
  executable: string | null;
  account: AgentAccount | null;
  issue: AgentProviderIssue | null;
  warnings: AgentProviderWarning[];
  models: AgentModel[];
  checkedAt: string;
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
  /** MCP servers the agent may call, by name, such as `arch`. */
  mcpServers?: Record<string, AgentMcpServer>;
};
/** A question the agent asks mid-turn. Answers are keyed by `id`; options are suggestions, free text is allowed. */
export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
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
  | { type: "question"; requestId: string; questions: AgentQuestion[] }
  /** Empty answers mean the question was dismissed, for example when the turn stopped. */
  | { type: "question-answered"; requestId: string; answers: Record<string, string> }
  /** The account's plan limit stopped the agent. `resetsAt` is an ISO time when the provider says. */
  | { type: "limit"; resetsAt: string | null }
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
  answer(requestId: string, answers: Record<string, string>): Promise<void>;
  /** Adds a message the agent reads at its next step. Rejects before the turn starts and after it ends. */
  steer(text: string): Promise<void>;
};
