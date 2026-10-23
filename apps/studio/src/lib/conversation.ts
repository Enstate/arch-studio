import type { StudioVersion } from "./model";

/**
 * A conversation continues its branch from where the branch stood when it began. `lineage` is the
 * branch's versions, newest first. It shows that starting version once, then only what was saved
 * after it began, so a new conversation never replays the branch's earlier history.
 */
export function conversationVersions(lineage: StudioVersion[], startedAt: string): { start: StudioVersion | undefined; since: StudioVersion[] } {
  return {
    start: lineage.find(version => version.createdAt <= startedAt),
    since: lineage.filter(version => version.createdAt > startedAt),
  };
}
