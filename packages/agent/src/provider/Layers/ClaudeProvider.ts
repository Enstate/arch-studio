import type { ModelCapabilities, ModelSelection, ServerProviderModel } from "../../contracts/index.ts";
import { createModelCapabilities, getModelSelectionStringOptionValue, getProviderOptionCurrentValue, getProviderOptionDescriptors } from "../../shared/model.ts";
import { claudeCatalog } from "../../catalog.ts";
const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// Arch: capabilities come from the T3 Code model catalog, which tracks current models.
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = claudeCatalog.map((model) => ({
  slug: model.slug,
  name: model.name,
  isCustom: false,
  capabilities: createModelCapabilities({ optionDescriptors: model.options }),
}));

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): `ultracode` is a
 * Claude Code setting that pairs with `xhigh`, `ultrathink` is filtered out
 * because it is a prompt-prefix mode, and older model compatibility mappings
 * are preserved for current Claude Code behavior.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const mapped = claudeCatalog.find((candidate) => candidate.slug === model?.trim())?.effortMap[effort];
  if (mapped === null || effort === "ultrathink") return undefined;
  return mapped ?? effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}
