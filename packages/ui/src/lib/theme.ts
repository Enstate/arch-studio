import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "arch-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Inline in <head> so the right class is on <html> before the first paint. */
export const themeScript = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");var d=t==="dark"||((!t||t==="system")&&matchMedia("${DARK_QUERY}").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;

const listeners = new Set<() => void>();

function readTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia(DARK_QUERY).matches);
  const root = document.documentElement;
  // Suppress transitions while the palette flips, so nothing animates between themes.
  root.classList.add("theme-switching");
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const mql = matchMedia(DARK_QUERY);
  const onSystem = () => {
    if (readTheme() === "system") apply("system");
    onChange();
  };
  mql.addEventListener("change", onSystem);
  window.addEventListener("storage", onSystem);
  return () => {
    listeners.delete(onChange);
    mql.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onSystem);
  };
}

export function setTheme(theme: Theme) {
  if (theme === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, theme);
  apply(theme);
  for (const listener of listeners) listener();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as const);
  const resolvedTheme = useSyncExternalStore<"light" | "dark">(
    subscribe,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  );
  return { theme, resolvedTheme, setTheme };
}
