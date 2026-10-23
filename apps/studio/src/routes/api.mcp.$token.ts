import { createFileRoute } from "@tanstack/react-router";
import { mcpResponse } from "../lib/mcp.server";
export const Route = createFileRoute("/api/mcp/$token")({ server: { handlers: { POST: ({ request, params }) => mcpResponse(request, params.token) } } });
