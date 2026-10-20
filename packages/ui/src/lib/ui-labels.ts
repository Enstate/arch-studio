import { createContext, useContext } from "react";

/** Screen-reader and tooltip text inside shared components. The app passes its own language through the provider. */
export const defaultUiLabels = {
  close: "Schließen",
  loading: "Wird geladen",
  toggleSidebar: "Seitenleiste ein- oder ausblenden",
  navigation: "Navigation",
  navigationDescription: "Projekte und Navigation",
  scrollToEnd: "Nach unten scrollen",
  scrollToStart: "Nach oben scrollen",
};

export type UiLabels = typeof defaultUiLabels;

const UiLabelsContext = createContext<UiLabels>(defaultUiLabels);

export const UiLabelsProvider = UiLabelsContext.Provider;

export const useUiLabels = () => useContext(UiLabelsContext);
