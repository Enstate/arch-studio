import type { AgentModelSetting } from "@arch/agent";
import type { Locale } from "./messages";

const en = {
  reasoning: "Thinking effort", serviceTier: "Processing speed", fastMode: "Fast mode",
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Maximum", ultra: "Ultra",
  standard: "Standard", priority: "Priority", flex: "Flexible",
  ultracodeHint: "Uses very high thinking effort and coordinates several agents.",
};
const labels: Record<Locale, Record<keyof typeof en, string>> = {
  en,
  de: {
    reasoning: "Denkaufwand", serviceTier: "Verarbeitungstempo", fastMode: "Schnellmodus",
    none: "Keiner", minimal: "Minimal", low: "Niedrig", medium: "Mittel", high: "Hoch", xhigh: "Sehr hoch", max: "Maximum", ultra: "Ultra",
    standard: "Standard", priority: "Priorität", flex: "Flexibel",
    ultracodeHint: "Nutzt sehr hohen Denkaufwand und koordiniert mehrere Agenten.",
  },
  es: {
    reasoning: "Esfuerzo de razonamiento", serviceTier: "Velocidad de procesamiento", fastMode: "Modo rápido",
    none: "Ninguno", minimal: "Mínimo", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo", ultra: "Ultra",
    standard: "Estándar", priority: "Prioridad", flex: "Flexible",
    ultracodeHint: "Usa un esfuerzo de razonamiento muy alto y coordina varios agentes.",
  },
  pt: {
    reasoning: "Esforço de raciocínio", serviceTier: "Velocidade de processamento", fastMode: "Modo rápido",
    none: "Nenhum", minimal: "Mínimo", low: "Baixo", medium: "Médio", high: "Alto", xhigh: "Muito alto", max: "Máximo", ultra: "Ultra",
    standard: "Padrão", priority: "Prioridade", flex: "Flexível",
    ultracodeHint: "Usa um esforço de raciocínio muito alto e coordena vários agentes.",
  },
};

/** Translate the settings Studio knows, while preserving new provider settings and their IDs. */
export function translateModelSettings(settings: AgentModelSetting[], locale: Locale): AgentModelSetting[] {
  const t = labels[locale];
  return settings.map(setting => {
    if (setting.id === "fastMode") return {...setting, label: t.fastMode};
    if (setting.type !== "select") return setting;
    const reasoning = setting.id === "effort" || setting.id === "reasoningEffort";
    if (!reasoning && setting.id !== "serviceTier") return setting;
    return {
      ...setting,
      label: reasoning ? t.reasoning : t.serviceTier,
      options: setting.options.map(option => {
        const id = option.id === "default" ? "standard" : option.id;
        const label = Object.hasOwn(t, id) ? t[id as keyof typeof t] : option.label;
        return {...option, label, description: option.id === "ultracode" ? t.ultracodeHint : reasoning || label !== option.label ? undefined : option.description};
      }),
    };
  });
}
