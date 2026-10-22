import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewerLocaleProvider } from "../../../../packages/viewer-ui/src/locale";
import { ViewerPane } from "../../../../packages/viewer-ui/src/viewer-pane";
import { languageNames, localeTags, preferredLocale, relativeTime } from "./locale";
import { studioText } from "./messages";
import { translateModelSettings } from "./model-settings";
import { studioFailure } from "./studio-errors";
import { threadTitle } from "./thread-title";
import {de as commonDe, en as commonEn, es as commonEs, pt as commonPt} from "../../../../packages/viewer-ui/src/messages/common";
import {de as viewerDe, en as viewerEn, es as viewerEs, pt as viewerPt} from "../../../../packages/viewer-ui/src/messages/viewer";
import { formatFor } from "../../../../packages/viewer-ui/src/format";

const common = {de: commonDe, en: commonEn, es: commonEs, pt: commonPt};
const viewer = {de: viewerDe, en: viewerEn, es: viewerEs, pt: viewerPt};
const locales = ["en", "de", "es", "pt"] as const;

test("saved language wins, regional browser languages resolve in order, and unsupported preferences fall back", () => {
  for (const locale of locales) {
    expect(preferredLocale(`other=1; arch-locale=${locale}`, ["de-DE"])).toBe(locale);
    expect(preferredLocale("arch-locale=invalid", [`${locale.toUpperCase()}-XX`, "en-US"])).toBe(locale);
  }
  expect(preferredLocale("", ["fr-FR", "pt-BR", "es-MX"])).toBe("pt");
  expect(preferredLocale("arch-locale=prototype", ["es-AR"])).toBe("es");
  expect(preferredLocale("", ["fr-FR"])).toBe("en");
  expect(preferredLocale("", [])).toBe("en");
});

function leaves(value: unknown, path = ""): Record<string, unknown> {
  if (typeof value === "string" || typeof value === "function") return {[path]: value};
  return Object.fromEntries(Object.entries(value as object).flatMap(([key, child]) => Object.entries(leaves(child, `${path}.${key}`))));
}

for (const locale of locales) {
  test(`${locale} catalogs are complete and preserve interpolation placeholders`, () => {
    for (const catalog of [studioText, common, viewer]) {
      const original = leaves(catalog.en);
      const translated = leaves(catalog[locale]);
      expect(Object.keys(translated).sort()).toEqual(Object.keys(original).sort());
      for (const [key, value] of Object.entries(translated)) {
        expect(typeof value, key).toBe(typeof original[key]);
        if (typeof value === "string") {
          expect(value.trim().length, key).toBeGreaterThan(0);
          expect(value, key).not.toContain("—");
          expect(value.match(/\{\w+\}/g)?.sort() ?? [], key).toEqual((original[key] as string).match(/\{\w+\}/g)?.sort() ?? []);
        }
      }
    }
    expect(viewer[locale].clock("09:30")).toContain("09:30");
    expect(common[locale].errors.notUploaded("drawing.pdf")).toContain("drawing.pdf");
    expect(common[locale].errors.tooManyMarks(17)).toContain("17");
  });

  test(`${locale} renders the viewer's actual processing screen in the chosen language`, () => {
    const html = renderToStaticMarkup(createElement(ViewerLocaleProvider, {locale},
      createElement(ViewerPane, {project: {id: "synthetic", name: "Synthetic", planUrl: null, status: "processing"}}),
    ));
    expect(html).toContain(viewer[locale].processing);
  });

  test(`${locale} supports formatting, recovery messages, and model settings without changing provider values`, () => {
    expect(languageNames[locale]).toBeTruthy();
    expect(formatFor(locale).number(1234.5)).toBe(new Intl.NumberFormat(localeTags[locale]).format(1234.5));
    const settings = translateModelSettings([
      {id: "reasoningEffort", label: "Reasoning", type: "select", options: [{id: "high", label: "High", isDefault: true}]},
      {id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false},
    ], locale);
    expect(settings[0]?.id).toBe("reasoningEffort");
    expect(settings[0]?.type === "select" && settings[0].options[0]?.id).toBe("high");
    expect(settings[0]?.type === "select" && settings[0].options[0]?.isDefault).toBe(true);
    expect(studioFailure(new Error("ARCH_SESSION_REQUIRED"), locale).message).toBe(studioText[locale].sessionRequired);
    const failure = studioFailure(new Error('The renderer stopped unexpectedly'), locale);
    expect(failure.message).not.toBe(failure.details!);
    expect(failure.details).toBe('The renderer stopped unexpectedly');
    expect(threadTitle("New thread", studioText[locale])).toBe(studioText[locale].newThread);
    expect(threadTitle("Kitchen redesign", studioText[locale])).toBe("Kitchen redesign");
  });
}

test("validation error codes translate without treating arbitrary diagnostics as codes", () => {
  const invalidFile = new Error(JSON.stringify([{code: "custom", message: "ARCH_REFERENCE_FILES"}]));
  expect(studioFailure(invalidFile, "es").message).toContain("Elige archivos");
  expect(studioFailure(invalidFile, "pt").details).toBeUndefined();
  expect(studioFailure(new Error("ARCH_NOT_A_REAL_CODE"), "pt").details).toBe("ARCH_NOT_A_REAL_CODE");
  const unknown = {id: "future", label: "Provider supplied setting", type: "boolean" as const};
  expect(translateModelSettings([unknown], "es")[0]).toBe(unknown);
});

test("conversation activity stays in the past and snoozed reminders stay in the future in every language", () => {
  const now = Date.UTC(2026, 9, 21, 12);
  for (const locale of locales) {
    const relative = new Intl.RelativeTimeFormat(localeTags[locale], {style: "narrow", numeric: "auto"});
    const format = {relative: relative.format.bind(relative)};
    for (const [unit, milliseconds] of [["minute", 60000], ["hour", 3600000], ["day", 86400000]] as const) {
      expect(relativeTime(now - 3 * milliseconds, now, format)).toBe(relative.format(-3, unit));
      expect(relativeTime(now + 3 * milliseconds, now, format)).toBe(relative.format(3, unit));
    }
    for (const code of ["ARCH_EDITS_BUSY", "ARCH_BUILDS_REQUIRED", "ARCH_SOURCE_CHANGED", "ARCH_ITEM_MISSING"]) {
      expect(studioFailure(new Error(code), locale).message).not.toContain("ARCH_");
    }
  }
});
