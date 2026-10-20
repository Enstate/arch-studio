import { type Locale, useLocale } from "./locale";

const TAGS: Record<Locale, string> = { de: "de-DE", en: "en-US" };

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(key: string, make: () => T): T {
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = make();
    cache.set(key, formatter);
  }
  return formatter as T;
}

function formatters(locale: Locale) {
  const tag = TAGS[locale];
  return {
    tag,
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      cached(`n|${tag}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(tag, options)).format(value),
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      cached(`d|${tag}|${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(tag, options)).format(value),
    relative: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) =>
      cached(`r|${tag}|${JSON.stringify(options)}`, () => new Intl.RelativeTimeFormat(tag, options)).format(value, unit),
    /** "84,5 m²" or "84.5 m²". */
    area: (m2: number, digits = 1) =>
      `${cached(`a|${tag}|${digits}`, () => new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits })).format(m2)} m²`,
  };
}

export type Format = ReturnType<typeof formatters>;

const byLocale: Record<Locale, Format> = { de: formatters("de"), en: formatters("en") };

/** Numbers, dates and relative times in a language, for code outside components. */
export const formatFor = (locale: Locale) => byLocale[locale];

export const useFormat = () => byLocale[useLocale()];
