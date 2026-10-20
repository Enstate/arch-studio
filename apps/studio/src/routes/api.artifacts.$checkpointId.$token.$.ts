import { createFileRoute } from "@tanstack/react-router";
import { artifactResponse } from "../lib/studio.server";
export const Route = createFileRoute("/api/artifacts/$checkpointId/$token/$")({ server: { handlers: { GET: ({ request, params }) => artifactResponse(request, params.checkpointId, params.token, params._splat ?? ""), HEAD: ({ request, params }) => artifactResponse(request, params.checkpointId, params.token, params._splat ?? "") } } });
