import { createFileRoute } from "@tanstack/react-router";
import { catalogResponse } from "../lib/catalog.server";
export const Route = createFileRoute("/api/catalog/$token/$")({ server: { handlers: { GET: ({ request, params }) => catalogResponse(request, params.token, params._splat ?? ""), HEAD: ({ request, params }) => catalogResponse(request, params.token, params._splat ?? "") } } });
