import { useSyncExternalStore } from "react";
import type { Locale } from "./messages";

export function preferredLocale(cookies: string, languages: readonly string[]): Locale {
  const saved = cookies.split(";").map(cookie => cookie.trim()).find(cookie => cookie.startsWith("arch-locale="))?.slice("arch-locale=".length);
  if (saved === "en" || saved === "de") return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "en" || base === "de") return base;
  }
  return "en";
}

const listeners = new Set<() => void>();
const notify = () => {for (const listener of listeners) listener();};
const localePreference = (): Locale => typeof navigator === "undefined" ? "en" : preferredLocale(document.cookie, navigator.languages.length ? navigator.languages : [navigator.language]);
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("languagechange", listener);
  return () => {listeners.delete(listener); window.removeEventListener("languagechange", listener);};
}
function selectLocale(locale: Locale) {
  // biome-ignore lint/suspicious/noDocumentCookie: Preserve the existing non-sensitive language preference.
  document.cookie = `arch-locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  notify();
}
export function useStudioLocale() {
  const locale = useSyncExternalStore(subscribe, localePreference, () => "en" as const);
  return {locale, selectLocale};
}
