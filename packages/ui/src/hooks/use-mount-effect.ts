import { useEffect } from "react";

/** The only sanctioned effect: sync with an external system once on mount. */
export function useMountEffect(effect: () => void | (() => void)) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once by design
  useEffect(effect, []);
}
