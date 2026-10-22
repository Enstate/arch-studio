import { createContext, useContext, type ReactNode } from "react";
import * as viewer from "./messages/viewer";
import * as common from "./messages/common";
export { useFormat } from "./format";
export type Locale = "de" | "en" | "es" | "pt";
const LocaleContext = createContext<Locale>("de");
export function ViewerLocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}
export const useLocale = () => useContext(LocaleContext);
const messages = {
  de: { ...common.de, viewer: viewer.de },
  en: { ...common.en, viewer: viewer.en },
  es: { ...common.es, viewer: viewer.es },
  pt: { ...common.pt, viewer: viewer.pt },
};
export type Messages = typeof messages.en;
export const useT = (): Messages => messages[useLocale()];
