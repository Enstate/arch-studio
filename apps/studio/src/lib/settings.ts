import type { AgentProvider, AgentProviderStatus } from "@arch/agent";
import { queryOptions } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { agentProviders } from "./server";

export const settingsSections = ["general", "appearance", "agents", "about"] as const;
export type SettingsSection = (typeof settingsSections)[number];

export const agentProvidersQuery = queryOptions({queryKey: ["studio-agent-providers"], queryFn: () => agentProviders({data: {refresh: false}}), staleTime: 30_000});

const listeners = new Set<() => void>();
const notify = () => {for (const listener of listeners) listener();};
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {listeners.delete(listener); window.removeEventListener("storage", listener);};
}

// Settings open over the current project, so closing them returns to the same place.
let openSection: SettingsSection | null = null;
export function openSettings(section: SettingsSection = "general") {openSection = section; notify();}
export function closeSettings() {openSection = null; notify();}
export const useSettingsSection = () => useSyncExternalStore(subscribe, () => openSection, () => null);
// The desktop app menu's Settings item (Cmd/Ctrl+,).
if (typeof window !== "undefined") window.archDesktop?.onOpenSettings?.(() => openSettings());

const disabledKey = "arch-disabled-agents";
let disabledRaw: string | null = null;
let disabledValue: AgentProvider[] = [];
function disabledAgents(): AgentProvider[] {
  const raw = localStorage.getItem(disabledKey);
  if (raw !== disabledRaw) {
    disabledRaw = raw;
    try {
      const value: unknown = JSON.parse(raw ?? "[]");
      disabledValue = Array.isArray(value) ? value.filter((item): item is AgentProvider => item === "claude" || item === "codex") : [];
    } catch {disabledValue = [];}
  }
  return disabledValue;
}
/** Agents switched off in Settings stay out of the model menu for new conversations. */
export function useDisabledAgents() {
  const disabled = useSyncExternalStore(subscribe, disabledAgents, () => disabledValue);
  const setAgentEnabled = (provider: AgentProvider, enabled: boolean) => {
    localStorage.setItem(disabledKey, JSON.stringify(enabled ? disabled.filter(item => item !== provider) : [...new Set([...disabled, provider])]));
    notify();
  };
  return {disabled, setAgentEnabled};
}

/** An agent can start a round when its CLI runs, it isn't signed out and it reports models. */
export const agentRunnable = (status: AgentProviderStatus) => status.installed && status.authenticated !== false && status.issue !== "failed" && status.issue !== "launcher-only" && status.models.length > 0;
