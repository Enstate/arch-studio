import type { ProjectFacts } from "@arch/project";
import { projectBranches } from "@arch/project-tools";
import { assignProjectClient, updateProjectFacts as saveProjectFacts } from "@arch/project-tools/intake";
import { z } from "zod";
import { changeCatalog, localCatalog, requireProject } from "./local-catalog";
import { requireStudio } from "./local-session";
import { holdProject } from "./rounds.server";
import { clientKey } from "./studio.server";

const localClient = { id: "local", name: "Local" };

async function boundSource(projectId: string) {
  const project = requireProject(await localCatalog(), projectId);
  if (!project.sourceId) throw new Error("ARCH_SOURCE_REQUIRED");
  return project.sourceId;
}

/**
 * Saves what the user confirmed on the overview to a branch folder as a new version, and renames
 * the project in Studio's catalog with it. A round working in that folder owns it until it ends.
 */
export async function updateProjectFacts({ data }: { data: { projectId: string; branch: string; name: string; facts: ProjectFacts; description?: string } }) {
  requireStudio();
  const sourceId = await boundSource(data.projectId);
  return holdProject(sourceId, [data.branch], async running => {
    if (running.has(data.branch)) throw new Error("ARCH_PROJECT_WORKING");
    return changeCatalog(async catalog => {
      const project = requireProject(catalog, data.projectId);
      if (project.sourceId !== sourceId) throw new Error("ARCH_SOURCE_CHANGED");
      const saved = await saveProjectFacts(sourceId, data.branch, { name: data.name, facts: data.facts, ...(data.description === undefined ? {} : { description: data.description }) });
      project.name = data.name;
      return { checkpointId: saved.id };
    });
  });
}

/**
 * Moves a project to an existing client, or to a new one named here. Every branch folder and the
 * catalog change in the same step, so the project keeps opening. While a round works anywhere in
 * the project, the move is refused.
 */
export async function assignClient({ data }: { data: { projectId: string; client: { id: string } | { name: string } } }) {
  requireStudio();
  const sourceId = await boundSource(data.projectId);
  const lines = (await projectBranches(sourceId)).branches;
  return holdProject(sourceId, lines.map(line => line.name), async running => {
    if (running.size) throw new Error("ARCH_PROJECT_WORKING");
    return changeCatalog(async catalog => {
      const project = requireProject(catalog, data.projectId);
      if (project.sourceId !== sourceId) throw new Error("ARCH_SOURCE_CHANGED");
      const choice = data.client;
      // A typed name that matches an existing client is that client, not a second one.
      const client = "id" in choice
        ? catalog.clients.find(item => item.id === choice.id) ?? (choice.id === localClient.id ? localClient : undefined)
        : catalog.clients.find(item => item.name.toLocaleLowerCase() === choice.name.toLocaleLowerCase()) ?? { id: clientKey(catalog, choice.name), name: choice.name };
      if (!client) throw new Error("ARCH_CLIENT_MISSING");
      if (client.id === project.clientId) return { clientId: client.id };
      await assignProjectClient(sourceId, client);
      if (!catalog.clients.some(item => item.id === client.id)) catalog.clients.push(client);
      project.clientId = client.id;
      return { clientId: client.id };
    });
  });
}

const places = z.array(z.object({
  display_name: z.string().min(1),
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
})).max(50);

/**
 * Looks an address up on OpenStreetMap's Nominatim. Studio sends it only when the user asks to
 * search, as Nominatim's usage policy requires, and names itself in the User-Agent.
 */
export async function findLocation({ data }: { data: { query: string; locale: string } }) {
  requireStudio();
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ format: "jsonv2", limit: "5", q: data.query, "accept-language": data.locale }).toString();
  let body: unknown;
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Arch Studio (+https://github.com/Enstate/arch-studio)", Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Nominatim answered ${response.status}`);
    body = await response.json();
  } catch (error) { throw new Error("ARCH_LOCATION_UNAVAILABLE", { cause: error }); }
  const found = places.safeParse(body);
  if (!found.success) throw new Error("ARCH_LOCATION_UNAVAILABLE");
  return found.data.slice(0, 5).map(place => ({ label: place.display_name.slice(0, 240), latitude: place.lat, longitude: place.lon }));
}
