import type { V1InitializeParams } from "../../codex-app-server/schema.ts";
export function buildCodexInitializeParams(): V1InitializeParams {
  return {
    clientInfo: { name: "arch_studio", title: "Arch Studio", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  };
}
