import { expect, test } from "bun:test";
import { viewerSupportsRuntime } from "@arch/project";
import { viewerRuntimeHash } from "../src/index.ts";

test("the installed sharpness runtime explicitly supports its reviewed predecessor", async () => {
  const current = await viewerRuntimeHash();
  const previous = "965f4dc2b58b7fae7bfcca230854b8731ffcdd03f109c8b3dbccd8abc12cd6c5";
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
