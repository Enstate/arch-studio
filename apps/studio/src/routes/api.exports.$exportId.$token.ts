import { createFileRoute } from "@tanstack/react-router";
import { exportResponse } from "../lib/project-package.server";
export const Route = createFileRoute("/api/exports/$exportId/$token")({ server: { handlers: {
  GET: ({ request, params }) => exportResponse(request, params.exportId, params.token),
  HEAD: ({ request, params }) => exportResponse(request, params.exportId, params.token),
} } });
