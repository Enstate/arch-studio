import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listProjects, studioStoreDirectory } from "@arch/project-tools";
import { z } from "zod";
import type { StudioCatalog, StudioProjectSummary } from "./model";
const schema = z.object({ clients: z.array(z.object({ id: z.string(), name: z.string() })), projects: z.array(z.object({ id: z.string(), clientId: z.string(), name: z.string(), sourceId: z.string().nullable(), createdAt: z.string() })) });
let pending: Promise<unknown> = Promise.resolve();
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function catalogLock(directory: string) {
  const lock = path.join(directory, "catalog.lock");
  const token = randomUUID();
  const candidate = path.join(directory, `.catalog-${token}`);
  await fs.writeFile(candidate, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 2500;
  try {
    while (true) {
      try { await fs.link(candidate, lock); return async () => { await fs.unlink(lock); }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      try {
        const contents = await fs.readFile(lock, "utf8");
        const owner = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).parse(JSON.parse(contents));
        if (!alive(owner.pid)) {
          // A durable, unique claim lets exactly one waiter recover this dead owner.
          // Keep the claim so a delayed waiter cannot remove a replacement lock.
          const claim = path.join(directory, `.recovered-${owner.token}`);
          try {
            await fs.writeFile(claim, "", { flag: "wx", mode: 0o600 });
            if (await fs.readFile(lock, "utf8") === contents) await fs.unlink(lock);
          } catch (error) { if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Date.now() >= deadline) throw new Error("Another Studio process is updating the catalog. Retry when it finishes.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally { await fs.unlink(candidate); }
}
export function changeCatalog<T>(change: (catalog: StudioCatalog) => Promise<T> | T): Promise<T> {
  const operation = pending.then(async () => {
    const directory = path.join(studioStoreDirectory(), "studio");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await catalogLock(directory);
    try {
      const file = path.join(directory, "catalog.json");
      let catalog: StudioCatalog;
      try { catalog = schema.parse(JSON.parse(await fs.readFile(file, "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; catalog = { clients: [], projects: [] }; }
      const result = await change(catalog);
      const temporary = `${file}.${randomUUID()}`;
      await fs.writeFile(temporary, JSON.stringify(catalog, null, 2), { mode: 0o600 });
      await fs.rename(temporary, file);
      return result;
    } finally { await release(); }
  });
  pending = operation.catch(() => {});
  return operation;
}
export async function localCatalog() {
  return changeCatalog(async catalog => {
    const sources = await listProjects();
    for (const source of sources) {
      const client = catalog.clients.find(client => client.id === source.manifest.client.id);
      if (client && client.name !== source.manifest.client.name) throw new Error(`Client ${client.id} has conflicting names in Studio and the source manifest.`);
      if (!client) catalog.clients.push(source.manifest.client);
      const bound = catalog.projects.find(project => project.sourceId === source.manifest.id);
      if (bound && bound.clientId !== source.manifest.client.id) throw new Error("A bound source changed its client identity. Restore its original manifest before continuing.");
      if (!catalog.projects.some(project => project.sourceId === source.manifest.id)) catalog.projects.push({ id: `source:${source.manifest.id}`, clientId: source.manifest.client.id, name: source.manifest.name, sourceId: source.manifest.id, createdAt: source.updatedAt });
    }
    return catalog;
  });
}
export function requireProject(catalog: StudioCatalog, projectId: string): StudioProjectSummary {
  const project = catalog.projects.find(project => project.id === projectId);
  if (!project) throw new Error("Unknown local Studio project.");
  return project;
}
