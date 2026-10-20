import geistLatin from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";

/** Preload the Latin subset the first paint needs, so text never renders in the fallback. Geist Mono loads on demand. */
export const fontPreloads = [geistLatin].map((href) => ({
  rel: "preload",
  href,
  as: "font",
  type: "font/woff2",
  crossOrigin: "anonymous" as const,
}));
