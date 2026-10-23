import { randomBytes, timingSafeEqual } from "node:crypto";
import { archMcpResponse } from "@arch/project-tools/mcp";
import { studioOrigin } from "./local-session";

/**
 * Studio serves Arch's MCP to the agents of its own rounds over loopback HTTP. Each round gets a
 * URL whose token names its project folder, and the URL stops working when the round ends.
 */

// Kept across development module reloads, so a round in progress keeps its tools.
const processState = globalThis as typeof globalThis & { archMcpGrants?: Map<string, { project: string }> };
processState.archMcpGrants ??= new Map();
const grants = processState.archMcpGrants;

/** A URL the round's agent reaches the MCP at, and the function that closes it again. */
export function grantRoundMcp(origin: string, project: string) {
  const token = randomBytes(32).toString("hex");
  grants.set(token, { project });
  return { url: `${origin}/api/mcp/${token}`, revoke: () => void grants.delete(token) };
}

export async function mcpResponse(request: Request, token: string) {
  try {
    studioOrigin(request);
    const grant = /^[a-f0-9]{64}$/.test(token) ? [...grants].find(([candidate]) => timingSafeEqual(Buffer.from(candidate), Buffer.from(token)))?.[1] : undefined;
    if (!grant) return new Response(null, { status: 404 });
    return await archMcpResponse(request, { project: grant.project });
  } catch (error) {
    console.error(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
    return new Response(null, { status: 404 });
  }
}
