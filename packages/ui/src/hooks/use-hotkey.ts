import { useRef } from "react";

import { useMountEffect } from "./use-mount-effect";

export type HotkeyHandler = (event: KeyboardEvent) => void;

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * Global keyboard shortcut. `combo` is a key with optional "mod+" (Cmd on macOS, Ctrl elsewhere)
 * and "shift+" prefixes, e.g. "mod+k" or "?". Plain keys are ignored while the user types.
 */
export function useHotkey(combo: string, handler: HotkeyHandler) {
  const latest = useRef(handler);
  latest.current = handler;

  useMountEffect(() => {
    const parts = combo.toLowerCase().split("+");
    const key = parts.at(-1);
    const mod = parts.includes("mod");
    const shift = parts.includes("shift");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key) return;
      if (mod !== (event.metaKey || event.ctrlKey)) return;
      // Symbols such as "/" and "?" need Shift on some layouts (German: Shift+7, Shift+ß), so only
      // letters and digits must match the Shift state exactly.
      if (shift ? !event.shiftKey : event.shiftKey && /^[a-z0-9]$/.test(key ?? "")) return;
      if (!mod && isTyping(event.target)) return;
      event.preventDefault();
      latest.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
}
