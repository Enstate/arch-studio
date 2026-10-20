import type { ProjectIntakePlan, ReviewNote, StudioProject } from "@arch/project";

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
};
