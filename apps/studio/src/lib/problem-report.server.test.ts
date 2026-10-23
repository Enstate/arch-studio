import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "@arch/project-tools/intake";
import { problemReportEntries } from "./problem-report.server";
import { rounds } from "./rounds.server";

test("a problem report holds logs, settings files, versions and failed rounds, never references, assets or the home path", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "arch-report-")));
  const prior = process.env.ARCH_HOME;
  const store = path.join(home, "store");
  process.env.ARCH_HOME = store;
  try {
    const inputs = path.join(home, "inputs");
    await mkdir(inputs);
    await writeFile(path.join(inputs, "site-plan.txt"), "REFERENCE-MARKER");
    const { project, checkpoint } = await initializeProject({ inputsDirectory: inputs, directory: path.join(home, "plaza"), id: "plaza", name: "Plaza", client: { id: "client", name: "Client" } });
    await mkdir(path.join(project.directory, "assets"), { recursive: true });
    await writeFile(path.join(project.directory, "assets", "bench.json"), "ASSET-MARKER");
    await mkdir(path.join(store, "logs"), { recursive: true });
    await mkdir(path.join(store, "studio"), { recursive: true });
    await writeFile(path.join(store, "logs", "studio.log"), `${JSON.stringify({ time: "2026-10-22T10:00:00.000Z", source: "projectDetails", code: "ARCH_PROJECT_FILE", message: `in ${project.directory}` })}\n`);
    const database = rounds();
    database.prepare("INSERT INTO rounds(id,source_id,branch,kind,status,request,attachments,provider,model,error,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("round-1", "plaza", "main", "request", "failed", "PROMPT-MARKER", JSON.stringify([{ name: "photo.png", sha256: "c".repeat(64), size: 1, mimeType: "image/png" }]), "claude", "opus", `Build failed in ${project.directory}`, "2026-10-22T09:00:00.000Z");
    const event = database.prepare("INSERT INTO round_events(round_id,seq,event) VALUES(?,?,?)");
    event.run("round-1", 0, JSON.stringify({ type: "session", resumeCursor: "SESSION-MARKER" }));
    event.run("round-1", 1, JSON.stringify({ type: "image", itemId: "a", sha256: "d".repeat(64), name: "view.png" }));
    event.run("round-1", 2, JSON.stringify({ type: "build", status: "failed", error: "arch.context.json is invalid", checkpointId: null }));

    const entries = await problemReportEntries({ appVersion: "1.2.3", providers: [{ provider: "claude", installed: true, authenticated: true, version: "2.0.0", executable: `${home}/bin/claude`, account: { kind: "subscription", plan: "max", email: "person@example.com" } as never, issue: null, warnings: [], models: [], checkedAt: "2026-10-22T09:00:00.000Z" }], home });
    const names = entries.map(entry => entry.name);
    expect(names).toEqual(expect.arrayContaining(["report.json", "logs/studio.log", "projects/plaza/main/arch.project.json", "projects/plaza/main/arch.context.json", "projects/plaza/main/package.json", "projects/plaza/versions.json", "projects/plaza/failed-rounds.json"]));
    expect(names.some(name => /reference|assets|outputs/.test(name))).toBe(false);
    const all = entries.map(entry => "text" in entry ? entry.text : "").join("\n");
    for (const kept of ["REFERENCE-MARKER", "ASSET-MARKER", "PROMPT-MARKER", "SESSION-MARKER", "person@example.com", "photo.png", "d".repeat(64), home]) expect(all).not.toContain(kept);
    const text = (name: string) => JSON.parse((entries.find(entry => entry.name === name) as { text: string }).text) as Record<string, unknown>;
    expect(text("report.json")).toMatchObject({ appVersion: "1.2.3", agents: [{ provider: "claude", installed: true, version: "2.0.0" }] });
    expect(JSON.stringify(text("projects/plaza/versions.json"))).toContain(checkpoint.id.slice(0, 12));
    const [failed] = text("projects/plaza/failed-rounds.json") as unknown as { error: string; lastEvents: { type: string }[] }[];
    expect(failed!.error).toBe("Build failed in ~/plaza");
    expect(failed!.lastEvents).toEqual([{ type: "session" }, { type: "image" }, { type: "build", status: "failed", error: "arch.context.json is invalid", checkpointId: null } as never]);
  } finally {
    // The rounds connection lives on the process. Let the next store open its own.
    const state = (globalThis as { archStudioRounds?: { database?: { close(): void }; schema?: number } }).archStudioRounds;
    state?.database?.close();
    if (state) { delete state.database; delete state.schema; }
    if (prior === undefined) delete process.env.ARCH_HOME; else process.env.ARCH_HOME = prior;
    await rm(home, { recursive: true, force: true });
  }
});
