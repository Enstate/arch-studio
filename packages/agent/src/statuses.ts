import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as NodePath from "node:path";
import { promisify } from "node:util";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { AgentAccount, AgentProvider, AgentProviderStatus } from "./api.ts";
import * as CodexClient from "./codex-app-server/client.ts";
import type { V2GetAccountResponse, V2ModelListResponse } from "./codex-app-server/schema.ts";
import { ownAgent } from "./lifecycle.ts";
import { buildCodexInitializeParams } from "./provider/Layers/CodexProvider.ts";
import { executablePath, launchablePath } from "./shared/shell.ts";
import { type CatalogOptionDescriptor, claudeCatalog, codexModelStatus } from "./catalog.ts";
import type { AgentModel, AgentModelSetting } from "./api.ts";

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function setting(descriptor: CatalogOptionDescriptor): AgentModelSetting {
  return descriptor.type === "select"
    ? { id: descriptor.id, label: descriptor.label, type: "select", options: descriptor.options }
    : { id: descriptor.id, label: descriptor.label, type: "boolean", ...(descriptor.currentValue !== undefined ? { currentValue: descriptor.currentValue } : {}) };
}
const effortLabels: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
/** Codex reports each model's efforts and service tiers. Legacy status comes from the T3 Code catalog. */
function codexModel(model: V2ModelListResponse["data"][number]): AgentModel {
  const settings: AgentModelSetting[] = [];
  if (model.supportedReasoningEfforts.length)
    settings.push({ id: "reasoningEffort", label: "Reasoning", type: "select", options: model.supportedReasoningEfforts.map((effort) => ({ id: effort.reasoningEffort, label: effortLabels[effort.reasoningEffort] ?? effort.reasoningEffort, description: effort.description, ...(effort.reasoningEffort === model.defaultReasoningEffort ? { isDefault: true } : {}) })) });
  if (model.serviceTiers?.length)
    settings.push({ id: "serviceTier", label: "Service Tier", type: "select", options: [{ id: "default", label: "Standard", ...(!model.defaultServiceTier ? { isDefault: true } : {}) }, ...model.serviceTiers.map((tier) => ({ id: tier.id, label: tier.name, description: tier.description, ...(tier.id === model.defaultServiceTier ? { isDefault: true } : {}) }))] });
  return { id: model.model, label: model.displayName, legacy: codexModelStatus[model.model] === "legacy", settings };
}

const execute = promisify(execFile);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Claude reports its sign-in through `auth status --json` and SDK initialization alike. */
function claudeAccount(value: Record<string, unknown>): AgentAccount | null {
  const service = text(value.apiProvider);
  if (service && service !== "firstParty") return { kind: "cloud", service };
  if (text(value.subscriptionType) || value.authMethod === "claude.ai")
    return { kind: "subscription", plan: text(value.subscriptionType), email: text(value.email) };
  if (value.loggedIn === true || text(value.apiKeySource)) return { kind: "api-key" };
  return null;
}
function codexAccount(account: V2GetAccountResponse["account"]): AgentAccount | null {
  if (!account) return null;
  if (account.type === "chatgpt")
    return { kind: "subscription", plan: account.planType === "unknown" ? null : account.planType, email: account.email };
  return account.type === "apiKey" ? { kind: "api-key" } : { kind: "cloud", service: "bedrock" };
}

/** Claude Code on Windows runs shell commands through Git Bash. It finds it the same way. */
function hasGitBash(env = process.env) {
  const exists = (path: string | undefined) => !!path && existsSync(path);
  if (exists(env.CLAUDE_CODE_GIT_BASH_PATH)) return true;
  const git = executablePath("git", "win32", env);
  return [
    git && NodePath.join(NodePath.dirname(git), "..", "bin", "bash.exe"),
    git && NodePath.join(NodePath.dirname(git), "..", "..", "bin", "bash.exe"),
    env.ProgramFiles && NodePath.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && NodePath.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].some((path) => exists(path || undefined));
}

async function providerStatus(provider: AgentProvider): Promise<AgentProviderStatus> {
  const resolved = launchablePath(provider);
  const binary = resolved?.executable;
  const status: AgentProviderStatus = {
    provider,
    installed: resolved !== undefined,
    authenticated: null,
    version: null,
    executable: resolved?.executable ?? resolved?.found ?? null,
    account: null,
    issue: null,
    warnings: provider === "claude" && process.platform === "win32" && !hasGitBash() ? ["git-bash-missing"] : [],
    models: [],
    checkedAt: new Date().toISOString(),
  };
  if (!resolved) return { ...status, issue: "not-installed" };
  if (!binary) return { ...status, issue: "launcher-only" };
  const abort = new AbortController();
  let task!: Promise<AgentProviderStatus>;
  const release = ownAgent(async () => {
    abort.abort();
    await task;
  });
  task = (async () => {
    try {
      const version = await execute(binary, ["--version"], {
        // Native CLI startup on Windows can take several seconds.
        timeout: 20_000,
        signal: abort.signal,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      status.version =
        `${version.stdout}\n${version.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
      if (provider === "claude") {
        // Auth details stay on this computer, in Studio's local status.
        let auth: unknown;
        try {
          auth = JSON.parse(
            (
              await execute(binary, ["auth", "status", "--json"], {
                timeout: 10_000,
                signal: abort.signal,
                maxBuffer: 64 * 1024,
                windowsHide: true,
              })
            ).stdout,
          );
        } catch (error) {
          // `auth status` exits 1 when logged out. It can still return valid JSON.
          const stdout =
            error && typeof error === "object" && "stdout" in error ? error.stdout : undefined;
          try {
            if (typeof stdout === "string") auth = JSON.parse(stdout);
          } catch {
            /* Older CLI or failed probe. */
          }
        }
        if (auth && typeof auth === "object" && "loggedIn" in auth && typeof auth.loggedIn === "boolean") {
          status.authenticated = auth.loggedIn;
          if (auth.loggedIn) status.account = claudeAccount(auth as Record<string, unknown>);
        }
        if (abort.signal.aborted) return { ...status, issue: "failed" };
        // Only an inconclusive auth check needs the slower SDK initialization.
        if (status.authenticated === null) {
          const timeout = setTimeout(() => abort.abort(), 25_000);
          let session: ReturnType<typeof query> | undefined;
          try {
            session = query({
              // Initialization only. No prompt reaches the model or starts a turn.
              prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
                if (!abort.signal.aborted)
                  await new Promise<void>((resolve) =>
                    abort.signal.addEventListener("abort", () => resolve(), { once: true }),
                  );
              })(),
              options: {
                pathToClaudeCodeExecutable: binary,
                abortController: abort,
                persistSession: false,
                settingSources: ["user"],
                allowedTools: [],
                mcpServers: {},
                strictMcpConfig: true,
                stderr: () => {},
              },
            });
            const account = (await session.initializationResult()).account;
            if (account?.tokenSource && account.tokenSource !== "none") {
              status.authenticated = true;
              status.account = claudeAccount(account);
            }
          } finally {
            clearTimeout(timeout);
            abort.abort();
            session?.close();
          }
        }
        status.models = claudeCatalog
          .filter((model) => !model.minVersion || !status.version || compareVersions(status.version, model.minVersion) >= 0)
          .map((model) => ({ id: model.slug, label: model.name, legacy: model.status === "legacy", settings: model.options.map(setting) }));
      } else {
        const runtime = ManagedRuntime.make(NodeServices.layer);
        try {
          const discovered = await runtime.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                const child = yield* spawner.spawn(
                  ChildProcess.make(binary, ["app-server"], {
                    extendEnv: true,
                    forceKillAfter: "2 seconds",
                  }),
                );
                // Build the client into this scope. Providing the layer to one effect
                // would close its reader before the first response arrives.
                const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
                const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                  Effect.provide(clientContext),
                );
                yield* client.request("initialize", buildCodexInitializeParams());
                yield* client.notify("initialized", undefined);
                const account: V2GetAccountResponse = yield* client.request("account/read", {});
                const models: AgentProviderStatus["models"] = [];
                let cursor: string | null | undefined;
                do {
                  const response: V2ModelListResponse = yield* client.request(
                    "model/list",
                    cursor ? { cursor } : {},
                  );
                  models.push(...response.data.map(codexModel));
                  cursor = response.nextCursor;
                } while (cursor);
                return {
                  authenticated: account.account ? true : account.requiresOpenaiAuth ? false : null,
                  account: codexAccount(account.account),
                  models,
                };
              }),
            ).pipe(Effect.timeout("20 seconds")),
            { signal: abort.signal },
          );
          status.authenticated = discovered.authenticated;
          status.account = discovered.account;
          status.models = discovered.models;
        } finally {
          await runtime.dispose();
        }
      }
      status.issue = status.authenticated === false ? "signed-out" : status.authenticated === null ? "unverified" : null;
      return status;
    } catch {
      return { ...status, issue: "failed" };
    } finally {
      release();
    }
  })();
  return task;
}

export async function providerStatuses(): Promise<AgentProviderStatus[]> {
  return Promise.all([providerStatus("claude"), providerStatus("codex")]);
}
