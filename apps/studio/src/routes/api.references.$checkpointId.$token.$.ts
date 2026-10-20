import { createFileRoute } from "@tanstack/react-router";
import { referenceResponse } from "../lib/studio.server";
export const Route = createFileRoute("/api/references/$checkpointId/$token/$")({ server: { handlers: {
  GET: ({ request, params }) => referenceResponse(request, params.checkpointId, params.token, params._splat ?? ""),
  HEAD: ({ request, params }) => referenceResponse(request, params.checkpointId, params.token, params._splat ?? ""),
} } });
