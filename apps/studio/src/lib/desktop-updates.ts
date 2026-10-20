import type { DesktopUpdate } from "../../../desktop/update-state";

let snapshot: DesktopUpdate | null = null;
let disconnect: (() => void) | undefined;
const listeners = new Set<() => void>();
const publish = (value: DesktopUpdate) => { snapshot = value; for (const listener of listeners) listener(); };

export function subscribeDesktopUpdates(listener: () => void) {
  listeners.add(listener);
  const bridge = window.archDesktop;
  if (bridge && !disconnect) {
    let received = false;
    let active = true;
    // Subscribe first so a late initial read cannot overwrite newer progress.
    const unsubscribe = bridge.onUpdateState(value => { received = true; publish(value); });
    disconnect = () => { active = false; unsubscribe(); };
    void bridge.getUpdateState().then(value => { if (active && !received) publish(value); }).catch(() => {
      if (active && !received) publish({ currentVersion: "", status: "error", operation: "check" });
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { disconnect?.(); disconnect = undefined; }
  };
}
export const desktopUpdateSnapshot = () => snapshot;
export const desktopUpdateServerSnapshot = () => null;
