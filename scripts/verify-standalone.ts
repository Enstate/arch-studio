/** Real local Studio smoke test. Requires built Studio, Bun and Chrome; never uses an existing store. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.join(root, "evidence/standalone");
const children = new Set<ChildProcess>();
const offMachine = new Set<string>();
let browser: Browser | undefined;
let temporary: string | undefined;
const checks: string[] = [];
async function cleanup() {
  await Promise.allSettled([browser?.close(), ...[...children].map(stop)]);
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
}
function passed(name: string) { checks.push(name); console.log(`PASS ${name}`); }
function loopback(url: string) { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); }
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
  children.delete(child);
}
function environment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: temporary!, TMPDIR: temporary!, ARCH_HOME: home };
}
async function server(home: string) {
  const child = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: root, env: { ...environment(home), ARCH_STUDIO_PORT: "0", ARCH_CLIENT_ROOT: path.join(root, "apps/studio/dist/client") }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const origin = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Studio readiness deadline exceeded")), 30000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Studio exited before readiness (${code})`)); });
    child.stdout!.on("data", data => {
      buffer += String(data);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const value = JSON.parse(line); if (value.archStudioReady === true && loopback(value.origin)) { clearTimeout(timeout); resolve(value.origin); } } catch { /* Framework startup may also log. */ }
      }
    });
    child.stderr!.resume();
  });
  return { child, origin };
}
async function cli(home: string, ...args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["packages/project-tools/src/cli.ts", ...args], { cwd: root, env: environment(home), stdio: ["ignore", "pipe", "pipe"] });
    children.add(child); let output = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI ${args[0]} timed out`)); }, 60000);
    child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.resume();
    child.once("exit", code => { clearTimeout(timeout); children.delete(child); code === 0 ? resolve(output) : reject(new Error(`CLI ${args[0]} failed (${code})`)); });
    child.once("error", reject);
  });
}
async function context(origin: string): Promise<BrowserContext> {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", colorScheme: "dark" });
  await context.addCookies([{ name: "arch-locale", value: "en", url: origin }]);
  await context.addInitScript(() => localStorage.setItem("theme", "dark"));
  await context.route("**/*", route => {
    const url = route.request().url();
    if (loopback(url)) return route.continue();
    offMachine.add(new URL(url).origin); return route.abort();
  });
  return context;
}
async function section(page: Page, name: string) {
  await page.getByRole("button", { name: "Project details and tools", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function viewer(page: Page) {
  await page.locator("[data-viewer] canvas").waitFor({ state: "visible", timeout: 60000 });
  // Viewer controls mount only after Viewer reports a live, first-frame-ready instance.
  await page.locator("[data-viewer] button").first().waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await page.locator("[data-viewer] [role=alert]").count(), 0);
}

try {
  console.log("Prerequisites: Bun runtime, installed lockfile dependencies, built apps/studio/dist/server/server.js and dist/client, Chrome (ARCH_CHROME_PATH optional). All stores and sources are synthetic and temporary.");
  await access(path.join(root, "apps/studio/dist/server/server.js"));
  await access(path.join(root, "apps/studio/dist/client"));
  const chrome = process.env.ARCH_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(chrome);
  temporary = await realpath(await mkdtemp(path.join(tmpdir(), "arch-standalone-")));
  await mkdir(evidence, { recursive: true });
  const home = path.join(temporary, "store"); const source = path.join(temporary, "source"); const inputs = path.join(temporary, "inputs");
  await mkdir(inputs);
  const reference = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect x="10" y="10" width="580" height="380" fill="white" stroke="black"/><text x="40" y="80">Synthetic studio: 6 m x 4 m, height 2.6 m</text></svg>';
  await writeFile(path.join(inputs, "dimensions.svg"), reference);
  await writeFile(path.join(inputs, "brief.txt"), "One synthetic rectangular room, 6 m by 4 m, 2.6 m high. Warm white walls and blue floor. No external assets.");
  let running = await server(home);
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-swiftshader"] });
  let session = await context(running.origin); let page = await session.newPage();
  page.setDefaultTimeout(15000);
  const artifacts = new Set<string>();
  page.on("request", request => { if (request.url().includes("/api/artifacts/")) artifacts.add(request.url()); });
  await page.goto(running.origin);
  await page.getByRole("button", { name: "Create client", exact: true }).first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Company name", { exact: true }).fill("Synthetic verification");
  await dialog.getByLabel("Client key", { exact: true }).fill("synthetic-verification");
  await dialog.getByRole("button", { name: "Create client", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project name", { exact: true }).fill("Standalone room");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("button", { name: "Start from documents", exact: true }).click();
  await page.getByLabel("Documents folder", { exact: true }).fill(inputs);
  await page.getByLabel("New destination folder", { exact: true }).fill(source);
  await page.getByRole("button", { name: "Prepare project", exact: true }).click();
  await page.getByText("Project prepared. Give the new folder to your agent", { exact: false }).waitFor();
  passed("UI client, project and document intake");
  const corners = [[0, 0], [6, 0], [6, 4], [0, 4]];
  const plan = { version: 1, name: "Standalone room", defaults: { wallHeight: 2.6, floor: "blue", interiorFinish: "white", exteriorFinish: "white", ceiling: "white" }, materials: { blue: { color: "#648fa8", roughness: 0.9 }, white: { color: "#efeae1", roughness: 0.9 } }, walls: corners.map((a, i) => ({ id: `wall-${i}`, a, b: corners[(i + 1) % 4], exterior: true })), rooms: [{ id: "studio", name: "Synthetic studio", polygon: corners, floor: "blue", wallFinish: "white" }] };
  await writeFile(path.join(source, "assets/plan.json"), JSON.stringify(plan));
  await page.getByRole("button", { name: "Build and version", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Execute source and build", exact: true }).click();
  await viewer(page);
  const checkpoint = await page.getByLabel("Versions", { exact: true }).inputValue();
  assert.match(checkpoint, /^[a-f0-9]{64}$/);
  await page.screenshot({ path: path.join(evidence, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await viewer(page);
  await page.screenshot({ path: path.join(evidence, "narrow.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  passed("confirmed source execution and actual desktop/narrow viewer");
  const artifact = [...artifacts].find(url => new URL(url).pathname.endsWith(".json"));
  assert.ok(artifact, "Viewer requested real artifact JSON");
  assert.equal((await fetch(artifact)).status, 404);
  assert.equal((await session.request.get(artifact, { headers: { Origin: "https://invalid.example" } })).status(), 404);
  assert.equal((await session.request.head(artifact)).status(), 200);
  const range = await session.request.get(artifact, { headers: { Range: "bytes=0-9" } });
  assert.equal(range.status(), 206); assert.equal((await range.body()).length, 10);
  passed("session, origin, HEAD and byte-range boundary");
  await section(page, "Files");
  const link = page.getByRole("link", { name: "dimensions.svg", exact: true });
  const href = await link.getAttribute("href"); assert.ok(href);
  const attachment = await session.request.get(href);
  assert.equal(attachment.status(), 200); assert.equal(await attachment.text(), reference);
  assert.match(attachment.headers()["content-disposition"]!, /^attachment/);
  assert.match(attachment.headers()["content-security-policy"]!, /sandbox/);
  assert.equal((await fetch(href)).status, 404);
  const downloaded = page.waitForEvent("download"); await link.click();
  assert.equal(await (await downloaded).failure(), null);
  passed("reference UI download, exact bytes and restrictive CSP");
  const note = "Synthetic private note: preserve the 6 by 4 metre room.";
  await section(page, "Review notes"); await page.getByLabel("Checkpoint review note").fill(note);
  await page.getByRole("button", { name: "Save note", exact: true }).click(); await page.getByText(note, { exact: true }).waitFor();
  await section(page, "Handoff");
  const bundle = path.join(temporary, "handoff");
  await page.getByRole("textbox", { name: "New destination folder", exact: true }).first().fill(bundle);
  await page.getByRole("button", { name: "Export handoff", exact: true }).click();
  await page.locator("pre").filter({ hasText: bundle }).waitFor();
  const independent = path.join(temporary, "independent-store"); const restored = path.join(temporary, "restored");
  await cli(independent, "import", bundle);
  await cli(independent, "restore", checkpoint, restored);
  assert.equal(await readFile(path.join(restored, "assets/plan.json"), "utf8"), JSON.stringify(plan));
  assert.ok((await cli(independent, "brief", checkpoint)).includes(note));
  const manifest = JSON.parse(await readFile(path.join(restored, "arch.project.json"), "utf8"));
  assert.equal(manifest.name, "Standalone room");
  passed("UI export and independent CLI import, restore, source bytes and private note");
  await session.close(); await stop(running.child); running = await server(home);
  session = await context(running.origin); page = await session.newPage();
  await page.goto(running.origin); await viewer(page);
  assert.equal(await page.getByLabel("Versions", { exact: true }).inputValue(), checkpoint);
  await section(page, "Review notes"); await page.getByText(note, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Standalone room", exact: true }).count(), 1);
  passed("restart preserves project, selected immutable version and private note");
  assert.deepEqual([...offMachine], [], "App attempted off-machine network access");
  passed("zero off-machine app requests");
  await writeFile(path.join(evidence, "checks.json"), JSON.stringify({ ok: true, checks, screenshots: ["desktop.png", "narrow.png"] }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, evidence }));
} catch (error) {
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "checks.json"), JSON.stringify({ ok: false, checks, error: error instanceof Error ? error.message : "Verification failed", offMachine: [...offMachine] }, null, 2));
  console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1;
} finally {
  await cleanup();
}
