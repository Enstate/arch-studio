# T3 Code provider port

Source: <https://github.com/pingdotgg/t3code>

Commit: `936593c2583c6640a07fc310f97bd5d0c27a7c31`.

The source was read from `/Users/feldrok/workspace/t3code` at that commit.
`LICENSE-t3code` is a byte-for-byte copy of its MIT license. The files below
retain upstream structure and names so fixes can be compared against that commit.
The package entry point exposes only the Promise and AsyncIterable API in
`src/api.ts`. Effect stays inside the package.

| Local file | Upstream file or source |
| --- | --- |
| `src/provider/Services/ProviderAdapter.ts` | `apps/server/src/provider/Services/ProviderAdapter.ts` |
| `src/provider/Services/ClaudeAdapter.ts` | `apps/server/src/provider/Services/ClaudeAdapter.ts` |
| `src/provider/Services/CodexAdapter.ts` | `apps/server/src/provider/Services/CodexAdapter.ts` |
| `src/provider/Layers/ClaudeAdapter.ts` | `apps/server/src/provider/Layers/ClaudeAdapter.ts` |
| `src/provider/Layers/ClaudeProvider.ts` | Model capabilities and model-option helpers from `apps/server/src/provider/Layers/ClaudeProvider.ts` |
| `src/provider/Drivers/ClaudeExecutable.ts` | `apps/server/src/provider/Drivers/ClaudeExecutable.ts` |
| `src/provider/Layers/CodexAdapter.ts` | `apps/server/src/provider/Layers/CodexAdapter.ts` |
| `src/provider/Layers/CodexSessionRuntime.ts` | `apps/server/src/provider/Layers/CodexSessionRuntime.ts` |
| `src/provider/Layers/CodexProvider.ts` | Initialization parameters from `apps/server/src/provider/Layers/CodexProvider.ts`, with Arch identity |
| `src/provider/Layers/codexLaunchArgs.ts` | `apps/server/src/provider/Layers/codexLaunchArgs.ts`, without the T3 environment override |
| `src/codexModelOptions.ts` | `apps/server/src/codexModelOptions.ts` |
| `src/provider/Errors.ts` | Adapter errors from `apps/server/src/provider/Errors.ts` |
| `src/provider/modelDescriptors.ts` | Option-descriptor helpers from `apps/server/src/provider/providerSnapshot.ts` |
| `src/shared/model.ts` | Required option/model helpers from `packages/shared/src/model.ts` |
| `src/shared/cliArgs.ts` | `packages/shared/src/cliArgs.ts` |
| `src/shared/hostProcess.ts` | Platform reference from `packages/shared/src/hostProcess.ts` |
| `src/shared/shell.ts` | Local PATH resolution replacing the host-shell services used by the adapters and ClaudeExecutable |
| `src/contracts/baseSchemas.ts` | Required primitives and IDs from `packages/contracts/src/baseSchemas.ts` |
| `src/contracts/model.ts` | Required option schemas and Claude/Codex aliases from `packages/contracts/src/model.ts`; legacy storage conversions removed |
| `src/contracts/providerInstance.ts` | Driver and internal correlation-ID brands from `packages/contracts/src/providerInstance.ts`; no instance registry or account settings |
| `src/contracts/orchestration.ts` | Required turn/approval/model schemas from `packages/contracts/src/orchestration.ts`; attachments carry absolute paths |
| `src/contracts/provider.ts` | Session, start/send, and raw event schemas from `packages/contracts/src/provider.ts`; adds round instructions |
| `src/contracts/providerRuntime.ts` | Canonical event schemas from `packages/contracts/src/providerRuntime.ts`; adds optional final-message summary |
| `src/codex-app-server/**` | Every non-test TypeScript file under `packages/effect-codex-app-server/src/**`, copied verbatim, including generated files |
| `src/statuses.ts` | Local CLI version/auth checks and initialization-only model discovery, following ClaudeProvider and CodexProvider probes |
| `src/provider/permissions.ts` | Arch policy for local tools, canonical paths, symlink escapes, and read-only writes |
| `src/api.ts`, `src/index.ts`, `src/events.ts`, `src/runner.ts`, `src/lifecycle.ts` | New Arch turn facade, event projection, validation, and process ownership |
| `tests/events.test.ts` | New focused test using an in-memory Claude SDK and synthetic project paths |

## Changes from upstream

- Removed T3 MCP back-channel setup, MCP bearer-token injection, attachment-store
  lookups, server-config dependencies, and native NDJSON loggers. Attachments
  are validated local image files. Neither CLI receives an alternate
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, home directory, or API key.
- Removed account/instance management, provider snapshots and settings layers,
  skills synchronization, version-advisory UI, other provider catalogs, legacy
  persisted-option conversions, and T3 shell environment discovery. Internal
  branded IDs remain to preserve the retained adapters' event and model types.
- Replaced the T3 developer/interaction-mode prompt with the caller's
  instructions. Claude appends them to its `claude_code` system preset. Codex
  receives them as thread developer instructions on both start and resume.
- The facade creates one internal adapter/session for one turn and disposes it
  before emitting `completed`. Durable provider IDs survive disposal and are
  emitted as plain resume cursors. Invalid Claude IDs fail validation. Codex
  resume failures propagate instead of silently starting a fresh thread.
- Kept the upstream item, delta, approval, turn, error, and interrupt handling.
  Final summary comes from Claude's result text or the last completed Codex
  assistant message, rather than concatenating intermediate commentary.
- Claude's mandatory PreToolUse hook applies the same approval callback even
  when `acceptEdits` or local allow rules would skip `canUseTool`. Paths are
  checked after resolving symlinks. Known write tools are denied in read-only
  mode, which also requires the CLI shell sandbox and forbids unsandboxed shell
  execution. Agent/Task delegation is disabled in read-only mode so it cannot
  launch an independent writer. Shell sandbox unavailability fails closed.
- Codex gets explicit turn write roots, no network, no temporary-directory write
  exceptions, and the requested native approval policy. Added the modern
  `item/permissions/requestApproval` handler to the retained Deferred approval
  path. Read-only turns decline file-change and write-permission grants.
- Moved the Codex adapter event fiber into the session scope. It must survive
  the scoped `startSession` call and end when that session is disposed.
- Structured chat questions have no representation in the requested API.
  Claude AskUserQuestion/ExitPlanMode are denied with an instruction to finish
  with text. Codex structured questions receive empty answers. Unsupported
  server tool calls fail through the upstream method-not-found response;
  there are no success-returning placeholder services.
- Retained SDK event exhaustiveness checks. Added explicit handling for the
  informational system subtypes and conversation-reset event introduced after
  upstream's SDK version, since the requested `^0.3.170` resolves to 0.3.305 in
  this lockfile. A reset interrupts the round.
- POSIX Claude executables are resolved against PATH before SDK launch. Windows
  resolution, like upstream, accepts only PATHEXT files, so npm's extensionless
  POSIX shim is never chosen. Windows `claude.cmd` and `codex.cmd` npm launchers
  are followed to the native `claude.exe` or the platform package's `codex.exe`.
  Unlike upstream, launchers are never run through `cmd.exe`; a launcher without a
  known native entry is reported as installed but not runnable.
- The desktop shell, not this package, supplies PATH. It reads PATH and agent
  settings from the macOS/Linux login shell and adds per-user Windows CLI
  directories, following T3's `DesktopShellEnvironment`.

## Sandboxed shell commands

Edit turns enable Claude's OS sandbox with `autoAllowBashIfSandboxed: true` and
`allowUnsandboxedCommands: false`, so Bash runs without prompts but cannot write
outside the project folder or reach the network. This matches Codex
`workspace-write`. Other tools keep the approval rules in `permissions.ts`.

## Native Codex permission limits

The requested `workspace-write` plus `on-request` mapping is retained. That
native policy allows ordinary sandboxed shell commands without asking. Both
native `workspace-write` and `read-only` policies permit filesystem reads
outside the working directory. Approval events represent provider requests for
escalation, not interception of every command or read. A command escalation
accepted by a user can run outside the original sandbox. Declining file-change
and write-profile grants does not turn a command escalation into a read-only
command. A host requiring an absolute no-write guarantee must not accept such
escalations during a read-only turn.

These native semantics cannot provide the brief's stronger requirement that
every command and outside read asks, or that accepting any command in a
read-only turn still forbids writes, while also retaining its specified native
sandbox and approval policy. This needs a parent decision before presenting
those stronger guarantees in Studio.

## Dependencies and verification

Direct dependencies are `effect` 4.0.0-beta.102,
`@anthropic-ai/claude-agent-sdk` ^0.3.170, and
`@effect/platform-node` 4.0.0-beta.102. The latter supplies filesystem, crypto,
path, and scoped child-process services for the original Effect adapters.
The root override pins its transitive `@effect/platform-node-shared` to the same
beta. Otherwise its prerelease caret range selects stable 4.0.5, whose Effect
peer is incompatible with beta.102. After the single `bun install`, a targeted
`bun update @effect/platform-node-shared` repaired that transitive resolution.
No existing package versions were upgraded.

The root `check-types:agent` script checks the package's own config, and
`bun run check-types` includes it.
Verification is limited to that config and `tests/events.test.ts`. No real
Claude or Codex turn, build, broad test suite, or development server was run.
The parent must smoke-test local CLI initialization, authentication, image input,
turn completion, resume, approval, interruption, and child-process cleanup.
