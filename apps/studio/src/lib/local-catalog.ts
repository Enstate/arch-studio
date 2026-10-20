import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listProjects, studioStoreDirectory } from "@arch/project-tools";
import { z } from "zod";
import type { StudioCatalog, StudioProjectSummary } from "./model";
const schema = z.object({ clients: z.array(z.object({ id: z.string(), name: z.string() })), projects: z.array(z.object({ id: z.string(), clientId: z.string(), name: z.string(), sourceId: z.string().nullable(), createdAt: z.string() })) });
let pending: Promise<unknown> = Promise.resolve();
export function changeCatalog<T>(change: (catalog: StudioCatalog) => Promise<T> | T): Promise<T> {
  const operation = pending.then(async () => {
    const directory = path.join(studioStoreDirectory(), "studio");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // SQLite owns cross-process locking and releases it after a crash. The local
    // queue keeps asynchronous changes on this process in transaction order.
    const file = path.join(directory, "catalog.sqlite");
    const database = new DatabaseSync(file);
    await fs.chmod(file, 0o600);
    try {
      database.exec("PRAGMA busy_timeout=2500; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)");
      database.exec("BEGIN IMMEDIATE");
      try {
        const stored = database.prepare("SELECT json FROM catalog WHERE id=1").get();
        const catalog = stored ? schema.parse(JSON.parse(String(stored.json))) : { clients: [], projects: [] };
        const result = await change(catalog);
        database.prepare("INSERT INTO catalog(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(JSON.stringify(catalog));
        database.exec("COMMIT");
        return result;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    } finally { database.close(); }
  });
  pending = operation.catch(() => {});
  return operation;
}
export async function localCatalog() {
  return changeCatalog(async catalog => {
    const sources = await listProjects();
    for (const source of sources) {
      const bound = catalog.projects.find(project => project.sourceId === source.manifest.id);
      // A changed source identity affects its project, never the other clients
      // and projects in this catalog. Details/build validate the binding again.
      if (bound && bound.clientId !== source.manifest.client.id) continue;
      const client = catalog.clients.find(client => client.id === source.manifest.client.id);
      // The stable key owns the relationship. Display names can change locally.
      if (!client) catalog.clients.push(source.manifest.client);
      if (!bound) catalog.projects.push({ id: `source:${source.manifest.id}`, clientId: source.manifest.client.id, name: source.manifest.name, sourceId: source.manifest.id, createdAt: source.updatedAt });
    }
    return catalog;
  });
}
export function requireProject(catalog: StudioCatalog, projectId: string): StudioProjectSummary {
  const project = catalog.projects.find(project => project.id === projectId);
  if (!project) throw new Error("Unknown local Studio project.");
  return project;
}
