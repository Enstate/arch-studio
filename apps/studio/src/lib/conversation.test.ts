import { expect, test } from "bun:test";
import { conversationVersions } from "./conversation";
import type { StudioVersion } from "./model";

const version = (id: string, createdAt: string, hasArtifact = true) => ({ id, checkpointId: id, parentId: null, createdAt, hasArtifact, references: [] }) as unknown as StudioVersion;

test("a new conversation starts from the branch's latest version and lists nothing before it", () => {
  // Newest first, as the branch lineage is.
  const lineage = [version("v29", "2026-10-21T10:00:00Z"), version("v28", "2026-10-21T09:00:00Z"), version("created", "2026-10-01T09:00:00Z", false)];
  const fresh = conversationVersions(lineage, "2026-10-22T08:00:00Z");
  expect(fresh.start?.id).toBe("v29");
  expect(fresh.since).toEqual([]);
});

test("an older conversation lists the versions saved since it began, after where it started", () => {
  const lineage = [version("v3", "2026-10-03T00:00:00Z"), version("v2", "2026-10-02T00:00:00Z"), version("v1", "2026-10-01T00:00:00Z")];
  const older = conversationVersions(lineage, "2026-10-02T12:00:00Z");
  expect(older.start?.id).toBe("v2");
  expect(older.since.map(item => item.id)).toEqual(["v3"]);
  // A conversation opened before anything was saved starts from nothing.
  expect(conversationVersions(lineage, "2026-09-30T00:00:00Z").start).toBeUndefined();
});
