import { useSyncExternalStore } from "react";
import type { Locale } from "./messages";

export const languageNames: Record<Locale, string> = { en: "English", de: "Deutsch", es: "Español", pt: "Português do Brasil" };
export const localeTags: Record<Locale, string> = { en: "en-US", de: "de-DE", es: "es", pt: "pt-BR" };
const supportedLocale = (value: string | undefined): value is Locale => value !== undefined && Object.hasOwn(languageNames, value);

export function preferredLocale(cookies: string, languages: readonly string[]): Locale {
  const saved = cookies.split(";").map(cookie => cookie.trim()).find(cookie => cookie.startsWith("arch-locale="))?.slice("arch-locale=".length);
  if (supportedLocale(saved)) return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (supportedLocale(base)) return base;
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

export function useStudioFormat() {
  const {locale} = useStudioLocale();
  const tag = localeTags[locale];
  return {
    date: (value: string | Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, options).format(typeof value === "string" ? new Date(value) : value),
    relative: (value: number, unit: Intl.RelativeTimeFormatUnit) => new Intl.RelativeTimeFormat(tag, {style: "narrow", numeric: "auto"}).format(value, unit),
    number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(tag, options).format(value),
    duration: (value: number, unit: "second" | "minute" | "hour") => new Intl.NumberFormat(tag, {style: "unit", unit, unitDisplay: "narrow"}).format(value),
  };
}

export type StudioFormat = ReturnType<typeof useStudioFormat>;

/** Relative activity and reminder times retain their past or future direction. */
export function relativeTime(value: number, now: number, format: Pick<StudioFormat, "relative">) {
  const seconds = Math.floor(Math.abs(value - now) / 1000);
  const direction = value < now ? -1 : 1;
  if (seconds < 60) return format.relative(0, "second");
  if (seconds < 3600) return format.relative(direction * Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return format.relative(direction * Math.floor(seconds / 3600), "hour");
  return format.relative(direction * Math.floor(seconds / 86400), "day");
}
