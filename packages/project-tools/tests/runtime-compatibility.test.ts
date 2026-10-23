import { expect, test } from "bun:test";
import { viewerSupportsRuntime } from "@arch/project";
import { viewerRuntimeHash } from "../src/index.ts";

test("the installed site runtime explicitly supports its reviewed predecessor", async () => {
  const current = await viewerRuntimeHash();
  const previous = "9dd05dcfcdf28f7fbecd9c31501285e442f5d907a8bd6f0b4957c7781a65b04f";
  expect(viewerSupportsRuntime(current, current)).toBe(true);
  expect(viewerSupportsRuntime(current, previous)).toBe(true);
  expect(viewerSupportsRuntime(previous, current)).toBe(false);
  expect(viewerSupportsRuntime(current, "a".repeat(64))).toBe(false);
  expect(viewerSupportsRuntime("a".repeat(64), previous)).toBe(false);
  for (const invalid of [undefined, "", "a", "z".repeat(64)]) {
    expect(viewerSupportsRuntime(current, invalid)).toBe(false);
    expect(viewerSupportsRuntime(invalid, previous)).toBe(false);
  }
});
