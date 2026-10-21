import type { ModelSelection } from "./contracts/index.ts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "./shared/model.ts";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const tier = getModelSelectionStringOptionValue(modelSelection, "serviceTier");
  // Arch: "default" is the picker's Standard choice. Codex picks its own default tier.
  return (
    (tier === "default" ? undefined : tier) ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
