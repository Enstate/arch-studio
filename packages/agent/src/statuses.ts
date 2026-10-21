import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { AgentProvider, AgentProviderStatus } from "./api.ts";
import * as CodexClient from "./codex-app-server/client.ts";
import type { V2ModelListResponse } from "./codex-app-server/schema.ts";
import { ownAgent } from "./lifecycle.ts";
import { buildCodexInitializeParams } from "./provider/Layers/CodexProvider.ts";
import { executablePath } from "./shared/shell.ts";
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

async function providerStatus(provider: AgentProvider): Promise<AgentProviderStatus> {
  const binary = executablePath(provider);
  const status: AgentProviderStatus = {
    provider,
    installed: binary !== undefined,
    authenticated: null,
    version: null,
    models: [],
    message: null,
  };
  if (!binary)
    return {
      ...status,
      message: `${provider === "claude" ? "Claude Code" : "Codex"} is not installed or is not on PATH.`,
    };
  const abort = new AbortController();
  let task!: Promise<AgentProviderStatus>;
  const release = ownAgent(async () => {
    abort.abort();
    await task;
  });
  task = (async () => {
    try {
      const version = await execute(binary, ["--version"], {
        timeout: 4_000,
        signal: abort.signal,
        maxBuffer: 64 * 1024,
      });
      status.version =
        `${version.stdout}\n${version.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
      if (provider === "claude") {
        // Auth CLI output stays local. Only its boolean is retained.
        try {
          const auth = await execute(binary, ["auth", "status", "--json"], {
            timeout: 10_000,
            signal: abort.signal,
            maxBuffer: 64 * 1024,
          });
          const value: unknown = JSON.parse(auth.stdout);
          if (
            value &&
            typeof value === "object" &&
            "loggedIn" in value &&
            typeof value.loggedIn === "boolean"
          )
            status.authenticated = value.loggedIn;
        } catch (error) {
          // `auth status` exits 1 when logged out. It can still return valid JSON.
          const stdout =
            error && typeof error === "object" && "stdout" in error ? error.stdout : undefined;
          if (typeof stdout === "string") {
            try {
              const auth = JSON.parse(stdout);
              if (typeof auth.loggedIn === "boolean") status.authenticated = auth.loggedIn;
            } catch {
              /* Older CLI or failed probe. */
            }
          }
        }
        if (abort.signal.aborted) return { ...status, message: "Provider status check stopped." };
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
            const initialization = await session.initializationResult();
            if (initialization.account?.tokenSource) status.authenticated = true;
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
                const account = yield* client.request("account/read", {});
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
                  models,
                };
              }),
            ).pipe(Effect.timeout("15 seconds")),
            { signal: abort.signal },
          );
          status.authenticated = discovered.authenticated;
          status.models = discovered.models;
        } finally {
          await runtime.dispose();
        }
      }
      if (status.authenticated === false)
        status.message = `Run ${provider} ${provider === "claude" ? "auth login" : "login"} to sign in.`;
      else if (status.authenticated === null)
        status.message = "Could not verify local authentication.";
      return status;
    } catch {
      return {
        ...status,
        message: abort.signal.aborted
          ? "Provider status check stopped or timed out."
          : "Could not complete the local provider status check.",
      };
    } finally {
      release();
    }
  })();
  return task;
}

export async function providerStatuses(): Promise<AgentProviderStatus[]> {
  return Promise.all([providerStatus("claude"), providerStatus("codex")]);
}
