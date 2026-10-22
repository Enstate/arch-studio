import { useSyncExternalStore } from "react";

// A project file opened from Finder or Explorer waits here until its dialog closes.
const listeners = new Set<() => void>();
let openedFile: string | null = null;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {listeners.delete(listener);};
}
function receive(path: string | null) {openedFile = path; for (const listener of listeners) listener();}
export const useOpenedProjectFile = () => useSyncExternalStore(subscribe, () => openedFile, () => null);
export const dismissOpenedProjectFile = () => receive(null);
if (typeof window !== "undefined") window.archDesktop?.onProjectFile?.(receive);
