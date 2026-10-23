import { useSyncExternalStore } from "react";
import type { AgentSetup } from "../../../desktop/update-state";

export type { AgentSetup };
const idle: AgentSetup = {provider: "claude", status: "idle", lines: []};
let snapshot: AgentSetup | null = null;
let disconnect: (() => void) | undefined;
const listeners = new Set<() => void>();
const publish = (value: AgentSetup) => {snapshot = value; for (const listener of listeners) listener();};

function subscribe(listener: () => void) {
  listeners.add(listener);
  const bridge = window.archDesktop;
  if (bridge?.onAgentSetup && bridge.getAgentSetup && !disconnect) {
    let received = false;
    let active = true;
    // Subscribe first so a late initial read cannot overwrite newer progress.
    const unsubscribe = bridge.onAgentSetup(value => {received = true; publish(value);});
    disconnect = () => {active = false; unsubscribe();};
    void bridge.getAgentSetup().then(value => {if (active && !received) publish(value);}).catch(() => {});
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {disconnect?.(); disconnect = undefined;}
  };
}
const current = () => snapshot ?? (window.archDesktop?.installAgent ? idle : null);

/** The desktop app's Claude Code setup. Null in the browser and in desktop builds without it. */
export const useAgentSetup = () => useSyncExternalStore(subscribe, current, () => null);
