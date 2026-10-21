import type { AgentEvent, AgentProvider } from "@arch/agent";
import type { CheckpointComparison, ProjectBranch, ProjectIntakePlan, ReviewNote, RoundAttachment, StudioProject } from "@arch/project";

export type StudioClient = { id: string; name: string };
export type StudioProjectSummary = {
  id: string;
  clientId: string;
  name: string;
  sourceId: string | null;
  createdAt: string;
};
export type StudioCatalog = {
  clients: StudioClient[];
  projects: StudioProjectSummary[];
};
export type StudioVersion = {
  id: string;
  checkpointId: string;
  parentId: string | null;
  createdAt: string;
  hasArtifact: boolean;
  artifactHash: string | null;
  intake: ProjectIntakePlan | null;
  intakeError: string | null;
  outputs: { id: string; kind: "still" | "film"; label: string; url: string }[];
  references: { path: string; label: string; kind: "floorplan" | "moodboard" | "other"; url: string }[];
};
export type StudioProjectDetails = {
  project: StudioProjectSummary;
  source: StudioProject | null;
  intake: ProjectIntakePlan | null;
  intakeError: string | null;
  versions: StudioVersion[];
  notes: ReviewNote[];
  branches: StudioBranch[];
};
export type RoundEvent =
  | AgentEvent
  | { type: "build"; status: "started" | "completed" | "failed" | "skipped"; error: string | null; checkpointId: string | null }
  | { type: "retry"; attempt: number; prompt: string }
  | { type: "image"; itemId: string; sha256: string; name: string };
export type RoundSummary = {
  id: string;
  branch: string;
  threadId: string | null;
  kind: "request" | "critique" | "build";
  status: "running" | "completed" | "failed" | "interrupted";
  request: string | null;
  attachments: RoundAttachment[];
  provider: AgentProvider | null;
  model: string | null;
  parentCheckpointId: string | null;
  checkpointId: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};
export type RoundActivity = { round: RoundSummary; from: number; events: RoundEvent[] };
export type StudioBranch = ProjectBranch & { primary: boolean };
export type StudioComparison = CheckpointComparison;
/** One agent session in a project. Several threads can share a branch folder. */
export type StudioThread = {
  id: string;
  projectId: string;
  projectName: string;
  clientId: string;
  clientName: string;
  branch: string;
  branchMissing: boolean;
  primary: boolean;
  headId: string | null;
  title: string;
  createdAt: string;
  status: "working" | "approval" | "failed" | "ready";
  workingSince: string | null;
  latestRequestAt: string | null;
  latestCompletedAt: string | null;
  provider: AgentProvider | null;
  model: string | null;
  settledOverride: "settled" | "active" | null;
  settledAt: string | null;
  snoozedUntil: string | null;
  snoozedAt: string | null;
  lastVisitedAt: string | null;
};
