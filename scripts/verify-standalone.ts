import { studioText } from "../apps/studio/src/lib/messages";
/** Real local Studio smoke test. Requires built Studio, Bun and Chrome; never uses an existing store. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.join(root, "evidence/standalone");
const children = new Set<ChildProcess>();
const offMachine = new Set<string>();
let browser: Browser | undefined;
let temporary: string | undefined;
let failurePage: (() => Page) | undefined;
const checks: string[] = [];
async function cleanup() {
  await Promise.allSettled([browser?.close(), ...[...children].map(stop)]);
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
}
function passed(name: string) { checks.push(name); console.log(`PASS ${name}`); }
function syntheticFloorPlanPdf() {
  const drawing = "0.8 w 30 30 540 340 re S BT /F1 20 Tf 50 325 Td (Synthetic floor plan) Tj 0 -35 Td (6 m x 4 m - ceiling 2.6 m) Tj ET 100 80 360 180 re S";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
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
  const readiness = await new Promise<{ origin: string; bootstrapUrl: string }>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Studio readiness deadline exceeded")), 30000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Studio exited before readiness (${code})`)); });
    child.stdout!.on("data", data => {
      buffer += String(data);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const value = JSON.parse(line); if (value.archStudioReady === true && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) && typeof value.bootstrapUrl === "string" && value.bootstrapUrl.startsWith(value.origin + "/#studio=") && /^[a-f0-9]{64}$/.test(new URL(value.bootstrapUrl).hash.slice("#studio=".length))) { clearTimeout(timeout); resolve({ origin: value.origin, bootstrapUrl: value.bootstrapUrl }); } } catch { /* Framework startup may also log. */ }
      }
    });
    child.stderr!.resume();
  });
  return { child, ...readiness };
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
async function context(origin: string, viewport = { width: 1440, height: 1000 }): Promise<BrowserContext> {
  const context = await browser!.newContext({ viewport, serviceWorkers: "block", colorScheme: "dark" });
  await context.addCookies([{ name: "arch-locale", value: "en", url: origin }]);
  await context.addInitScript(() => localStorage.setItem("arch-theme", "dark"));
  await context.route("**/*", route => {
    const url = route.request().url();
    // Chrome's bundled PDF viewer loads its own extension scripts. These are
    // browser resources, not off-machine app requests.
    const location = new URL(url);
    const bundledPdf = location.protocol === "chrome-extension:" && location.hostname === "mhjfbmdgcfjbbpaeojofohoefgiehjai";
    const browserResources = location.protocol === "chrome:" && location.hostname === "resources";
    if (loopback(url) || bundledPdf || browserResources) return route.continue();
    offMachine.add(location.origin); return route.abort();
  });
  return context;
}
async function section(page: Page, name: string) {
  const primary = ({ "Project overview": "intake", "View project": "preview", "Work plan": "work", Files: "files" } as Record<string, string>)[name];
  if (primary) { await page.locator(`[data-studio-view="${primary}"]:visible`).click(); return; }
  await page.getByRole("button", { name: "Project details and tools", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}
async function viewer(page: Page) {
  await page.locator("[data-viewer] canvas").waitFor({ state: "visible", timeout: 60000 });
  // Viewer controls mount only after Viewer reports a live, first-frame-ready instance.
  await page.locator("[data-viewer] button").first().waitFor({ state: "visible", timeout: 60000 });
  await page.locator('[data-studio-preview="ready"]').waitFor({ state: "visible", timeout: 60000 });
  await page.getByRole("progressbar").waitFor({ state: "hidden", timeout: 10000 });
  assert.equal(await page.locator("[data-viewer] [role=alert]").count(), 0);
}
async function otherPort(page: Page, secret: string, bootstrap: string) {
  const requests: string[] = [];
  const probe = createServer((request, response) => {
    requests.push(JSON.stringify({ url: request.url, headers: request.headers }));
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Local isolation probe</title>");
  });
  try {
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    await page.goto(`http://127.0.0.1:${address.port}`);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("arch-studio-session")), null);
    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.ok(!request.includes(secret) && !request.includes(bootstrap), "Another loopback port received a credential");
      assert.ok(!request.includes("x-arch-studio-session") && !request.includes("arch-studio-session-"), "Another loopback port received ambient Studio authentication");
    }
  } finally { await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); }
}
function changedCapability(url: string) {
  const changed = new URL(url);
  const segments = changed.pathname.split("/");
  assert.match(segments[4]!, /^[a-f0-9]{64}$/);
  segments[4] = (segments[4]![0] === "0" ? "1" : "0") + segments[4]!.slice(1);
  changed.pathname = segments.join("/");
  return changed.href;
}

try {
  console.log("Prerequisites: Bun runtime, installed lockfile dependencies, built apps/studio/dist/server/server.js and dist/client, Chrome (ARCH_CHROME_PATH optional). All stores and sources are synthetic and temporary.");
  await access(path.join(root, "apps/studio/dist/server/server.js"));
  await access(path.join(root, "apps/studio/dist/client"));
  const chrome = process.env.ARCH_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(chrome);
  temporary = await realpath(await mkdtemp(path.join(tmpdir(), "arch-standalone-")));
  await mkdir(evidence, { recursive: true });
  const home = path.join(temporary, "store"); const inputs = path.join(temporary, "inputs");
  await mkdir(inputs);
  const reference = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect x="10" y="10" width="580" height="380" fill="white" stroke="black"/><text x="40" y="80">Synthetic studio: 6 m x 4 m, height 2.6 m</text><script>globalThis.__referenceExecuted = true;</script></svg>';
  await writeFile(path.join(inputs, "dimensions.svg"), reference);
  const floorPlanPdf = syntheticFloorPlanPdf();
  await writeFile(path.join(inputs, "floor-plan.pdf"), floorPlanPdf);
  await writeFile(path.join(inputs, "brief.txt"), "One synthetic rectangular room, 6 m by 4 m, 2.6 m high. Warm white walls and blue floor. No external assets.");
  let running = await server(home);
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-swiftshader"] });
  let session = await context(running.origin); let page = await session.newPage();
  failurePage = () => page;
  page.setDefaultTimeout(15000);
  const artifacts = new Set<string>();
  page.on("request", request => { if (request.url().includes("/api/artifacts/")) artifacts.add(request.url()); });
  const unpaired = await context(running.origin);
  const denied = await unpaired.newPage();
  await denied.goto(running.origin);
  await denied.getByText(studioText.en.sessionRequired, {exact: true}).waitFor();
  assert.equal((await unpaired.cookies()).filter(cookie => cookie.name.startsWith("arch-studio-session-")).length, 0);
  passed("unpaired loopback browser cannot acquire a Studio session");
  const metadataRequest = page.waitForRequest(request => request.method() === "GET" && Boolean(request.headers()["x-arch-studio-session"]));
  await page.goto(running.bootstrapUrl);
  await page.getByRole("button", { name: "New project", exact: true }).first().waitFor();
  assert.equal(new URL(page.url()).hash, "");
  const metadata = await metadataRequest;
  const secret = await page.evaluate(() => sessionStorage.getItem("arch-studio-session"));
  assert.match(secret!, /^[a-f0-9]{64}$/);
  assert.equal((await session.cookies()).filter(cookie => cookie.name.startsWith("arch-studio-session")).length, 0);
  const metadataHeaders = metadata.headers();
  const authorized = await session.request.get(metadata.url(), {headers: metadataHeaders});
  assert.equal(authorized.status(), 200, "The captured request must reach the authenticated metadata function");
  const {"x-arch-studio-session": _secret, ...unpairedHeaders} = metadataHeaders;
  const refused = await unpaired.request.get(metadata.url(), {headers: unpairedHeaders});
  const refusal = await refused.text();
  assert.ok(refusal.includes('"error"') && refusal.includes("ARCH_SESSION_REQUIRED"), "The same metadata request without its bearer must return an authorization error");
  await unpaired.close();
  await otherPort(page, secret!, new URL(running.bootstrapUrl).hash.slice("#studio=".length));
  await page.goto(running.origin);
  await page.getByRole("button", { name: "New project", exact: true }).first().waitFor();
  passed("origin-scoped bearer protects metadata, survives navigation, and never reaches another loopback port");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project name", { exact: true }).fill("Standalone room");
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "New client…", exact: true }).click();
  await dialog.getByLabel(studioText.en.clientName, { exact: true }).fill("Synthetic verification");
  await dialog.locator("#new-project-references").setInputFiles([path.join(inputs, "dimensions.svg"), path.join(inputs, "floor-plan.pdf"), path.join(inputs, "brief.txt")]);
  await dialog.getByText("brief.txt", { exact: true }).waitFor();
  // Verification never starts a real agent, even when the machine has one signed in.
  const startIntake = dialog.getByLabel(studioText.en.startIntake, { exact: false });
  if (await startIntake.count()) await startIntake.uncheck();
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const created = JSON.parse(await cli(home, "list")).find((project: {manifest: {name: string}}) => project.manifest.name === "Standalone room");
  assert.ok(created, "New project registers a source");
  const source: string = created.directory;
  assert.equal(source, path.join(home, "projects", created.manifest.id, "branches/main"), "New project sources live in the managed store");
  assert.equal(created.manifest.client.id, "synthetic-verification");
  assert.equal(await readFile(path.join(source, "reference/dimensions.svg"), "utf8"), reference);
  // A new project opens on its home, with suggested first requests.
  await page.getByText(studioText.en.getStarted, { exact: true }).waitFor();
  await page.getByRole("button", { name: studioText.en.reviewDocuments, exact: false }).waitFor();
  // Rounds opens its conversation. Creating the project is its first saved state, not a numbered version.
  await page.locator('[data-studio-view="rounds"]:visible').click();
  await page.getByText(`${studioText.en.projectCreated} · 3 ${studioText.en.filesShort}`, { exact: true }).waitFor();
  assert.equal(await page.getByText(`${studioText.en.version} 1`, { exact: false }).count(), 0, "No version number before a model is built");
  await page.getByRole("button", { name: studioText.en.reviewDocuments, exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: studioText.en.composerPlaceholder, exact: true }).inputValue(), studioText.en.reviewDocumentsRequest);
  await page.getByRole("textbox", { name: studioText.en.composerPlaceholder, exact: true }).fill("");
  await section(page, "Project overview");
  await page.locator("[data-studio-intake]").waitFor();
  assert.equal(await page.locator("[data-viewer] canvas").count(), 0);
  const intakePath = path.join(source, "source/intake.json");
  const intake = JSON.parse(await readFile(intakePath, "utf8"));
  intake.brief = "A synthetic room, planned before any model exists.";
  intake.style = "Warm plaster and natural oak.";
  const drawing = intake.documents.find((document: {path: string}) => document.path === "reference/dimensions.svg");
  assert.ok(drawing);
  drawing.label = "Dimensioned room";
  drawing.role = "primary";
  drawing.level = "Ground floor";
  intake.pieces = [{ id: "room-shell", label: "Room shell", scope: "Trace the four walls and preserve the opening.", documentIds: [drawing.id], dependsOn: [], status: "blocked", nextAction: "Confirm ceiling height before building." }];
  await writeFile(intakePath, JSON.stringify(intake));
  await cli(home, "continue", source);
  const savedSource = JSON.parse(await cli(home, "list")).find((project: {directory: string}) => project.directory === source);
  assert.ok(savedSource?.checkpointId);
  // Variant and version live in the floating design-line panel.
  await page.locator("[data-studio-version]").click();
  await page.getByRole("button", { name: "Versions", exact: true }).click();
  await page.locator(`[data-studio-version-option="${savedSource.checkpointId}"]`).click();
  await page.getByText(intake.brief, { exact: true }).waitFor();
  await page.locator("[data-studio-questions]").getByText("Confirm ceiling height before building.", { exact: true }).waitFor();
  await page.getByText("Ground floor", { exact: false }).waitFor();
  // Originals download from the file viewer; list rows only open it.
  await page.locator("[data-studio-intake]").getByRole("button", { name: "Dimensioned room", exact: false }).first().click();
  const intakeDocument = page.locator("[data-studio-file-viewer]").getByRole("link", { name: "Download: Dimensioned room", exact: true });
  const intakeDocumentUrl = await intakeDocument.getAttribute("href");
  await section(page, "Project overview");
  assert.ok(intakeDocumentUrl);
  const intakeReference = await session.request.get(intakeDocumentUrl);
  assert.equal(intakeReference.status(), 200);
  assert.equal(await intakeReference.text(), reference);
  await page.screenshot({ path: path.join(evidence, "intake-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  await page.screenshot({ path: path.join(evidence, "intake-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  passed("structured intake updates before modeling, with saved reference access");
  passed("UI client, project and document intake");
  // Live document IDs can be reassigned while an older saved version stays selected.
  const changedIntake = structuredClone(intake);
  const liveDrawing = changedIntake.documents.find((document: {path: string}) => document.path === "reference/dimensions.svg");
  const livePdf = changedIntake.documents.find((document: {path: string}) => document.path === "reference/floor-plan.pdf");
  [liveDrawing.id, livePdf.id] = [livePdf.id, liveDrawing.id];
  changedIntake.pieces[0].nextAction = "Review the PDF page linked by the current work plan.";
  await writeFile(intakePath, JSON.stringify(changedIntake));
  await section(page, "Work plan");
  const livePiece = page.locator('[data-studio-piece="room-shell"]');
  await livePiece.getByText(changedIntake.pieces[0].nextAction, {exact: true}).waitFor();
  await livePiece.locator("summary").click();
  await livePiece.getByRole("button", {name: "floor-plan.pdf", exact: true}).waitFor();
  assert.equal(await livePiece.getByRole("button", {name: "Dimensioned room", exact: true}).count(), 0);
  await livePiece.getByRole("button", {name: "floor-plan.pdf", exact: true}).click();
  const savedPdfId = intake.documents.find((document: {path: string}) => document.path === "reference/floor-plan.pdf").id;
  await page.locator(`[data-studio-file-viewer="${savedPdfId}"] iframe`).waitFor();
  await section(page, "Work plan");
  await livePiece.locator("summary").click();
  livePdf.page = 2;
  changedIntake.pieces[0].nextAction = "Review the new page, which is not saved in this version.";
  await writeFile(intakePath, JSON.stringify(changedIntake));
  await livePiece.getByText(changedIntake.pieces[0].nextAction, {exact: true}).waitFor();
  assert.equal(await livePiece.getByRole("button", {name: "floor-plan.pdf File unavailable", exact: true}).isDisabled(), true);
  await writeFile(intakePath, JSON.stringify(intake));
  passed("live work-plan links follow document paths and pages across reassigned IDs, and expose unsaved pages");
  const corners = [[0, 0], [6, 0], [6, 4], [0, 4]];
  const plan = { version: 1, name: "Standalone room", defaults: { wallHeight: 2.6, floor: "blue", interiorFinish: "white", exteriorFinish: "white", ceiling: "white" }, materials: { blue: { color: "#648fa8", roughness: 0.9 }, white: { color: "#efeae1", roughness: 0.9 } }, walls: corners.map((a, i) => ({ id: `wall-${i}`, a, b: corners[(i + 1) % 4], exterior: true })), rooms: [{ id: "studio", name: "Synthetic studio", polygon: corners, floor: "blue", wallFinish: "white" }] };
  await writeFile(path.join(source, "assets/plan.json"), JSON.stringify(plan));
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: studioText.en.authorizeBuild, exact: true }).click();
  await viewer(page);
  const checkpoint = await page.locator("[data-studio-version]").getAttribute("data-studio-version");
  assert.ok(checkpoint);
  assert.match(checkpoint, /^[a-f0-9]{64}$/);
  // The header names the design line and version for people; hashes stay in the version list.
  assert.match(await page.locator("[data-studio-version]").innerText(), /Main design · Version \d+/);
  await page.screenshot({ path: path.join(evidence, "desktop.png") });
  const narrowContext = await context(running.origin, { width: 390, height: 844 });
  const narrow = await narrowContext.newPage();
  await narrow.goto(running.bootstrapUrl); await section(narrow, "View project"); await viewer(narrow);
  await narrow.screenshot({ path: path.join(evidence, "narrow.png") });
  await narrowContext.close();
  passed("confirmed source execution and actual desktop/narrow viewer");
  // Threads are agent sessions. A thread can work on a new branch forked from the current version.
  const mainThread = await page.locator("[data-studio-thread][aria-current] , [data-studio-thread]:has([aria-current])").first().getAttribute("data-studio-thread");
  assert.ok(mainThread, "The project opens on its main thread");
  await page.locator("[data-studio-branch]").click();
  await page.getByRole("button", { name: "Variants", exact: true }).click();
  await page.getByRole("menuitem", { name: "New variant from this version", exact: true }).click();
  await page.locator('[data-studio-branch]:not([data-studio-branch="main"])').waitFor();
  await page.getByText(studioText.en.forkedFrom, { exact: false }).waitFor();
  assert.equal(await page.locator("li[data-studio-thread]").count(), 2, "Both threads show in the sidebar");
  const variantBranch = (await page.locator("[data-studio-branch]").getAttribute("data-studio-branch"))!;
  const branchFolder = path.join(home, "projects", created.manifest.id, "branches", variantBranch);
  assert.equal(await readFile(path.join(branchFolder, "assets/plan.json"), "utf8"), JSON.stringify(plan));
  await writeFile(path.join(branchFolder, "assets/plan.json"), JSON.stringify({ ...plan, materials: { ...plan.materials, blue: { color: "#2f5f8a", roughness: 0.8 } } }));
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await viewer(page);
  const variant = await page.locator("[data-studio-version]").getAttribute("data-studio-version");
  assert.ok(variant && variant !== checkpoint, "The branch builds its own version without asking again");
  assert.equal(JSON.parse(await cli(home, "list")).find((project: {manifest: {id: string}}) => project.manifest.id === created.manifest.id).checkpointId, checkpoint, "Branch builds leave the primary line unchanged");
  await section(page, "Compare");
  await page.getByText("Changed files", { exact: false }).waitFor();
  await page.locator("li", { hasText: "assets/plan.json" }).first().waitFor();
  await page.getByText("Changed blue", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "compare.png") });
  await page.locator(`li[data-studio-thread="${mainThread}"] [role="button"]`).click();
  await page.locator('[data-studio-branch="main"]').waitFor();
  await section(page, "View project");
  await viewer(page);
  assert.equal(await page.locator("[data-studio-version]").getAttribute("data-studio-version"), checkpoint);
  passed("threads fork a branch from a version, build under the existing grant, compare, and keep the primary line");
  await writeFile(intakePath, "{");
  await section(page, "Project overview");
  await page.getByText(studioText.en.intakeInvalid, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "intake-invalid.png") });
  await section(page, "View project");
  await viewer(page);
  await writeFile(intakePath, JSON.stringify(intake));
  await section(page, "Project overview");
  await page.getByText(intake.brief, { exact: true }).waitFor();
  await section(page, "View project");
  await viewer(page);
  passed("invalid intake stays isolated from the saved model and recovers after correction");
  const artifact = [...artifacts].find(url => new URL(url).pathname.endsWith(".json"));
  assert.ok(artifact, "Viewer requested real artifact JSON");
  assert.equal((await fetch(artifact)).status, 200);
  assert.equal((await fetch(changedCapability(artifact))).status, 404);
  assert.equal((await fetch(artifact.slice(0, artifact.lastIndexOf("/") + 1) + "..%2Farch.project.json")).status, 404);
  assert.equal((await session.request.get(artifact, { headers: { Origin: "https://invalid.example" } })).status(), 404);
  assert.equal((await session.request.head(artifact)).status(), 200);
  const range = await session.request.get(artifact, { headers: { Range: "bytes=0-9" } });
  assert.equal(range.status(), 206); assert.equal((await range.body()).length, 10);
  passed("artifact capability, origin, HEAD and byte-range boundary");
  await section(page, "Files");
  const row = page.locator(`[data-studio-file="${drawing.id}"]`);
  await row.getByRole("button").click();
  assert.equal(await row.getByRole("link").count(), 0, "List rows no longer download");
  await page.locator(`[data-studio-file-viewer="${drawing.id}"]`).getByRole("button", { name: "Show in folder: Dimensioned room", exact: true }).waitFor();
  await page.getByRole("button", { name: "Show project folder", exact: true }).waitFor();
  const link = page.locator(`[data-studio-file-viewer="${drawing.id}"]`).getByRole("link", { name: "Download: Dimensioned room", exact: true });
  const href = await link.getAttribute("href"); assert.ok(href);
  const attachment = await session.request.get(href);
  assert.equal(attachment.status(), 200); assert.equal(await attachment.text(), reference);
  assert.match(attachment.headers()["content-disposition"]!, /^attachment/);
  assert.match(attachment.headers()["content-security-policy"]!, /sandbox/);
  assert.equal((await fetch(href)).status, 200);
  assert.equal((await fetch(changedCapability(href))).status, 404);
  assert.equal((await fetch(href.slice(0, href.lastIndexOf("/") + 1) + "..%2Farch.project.json")).status, 404);
  assert.equal((await fetch(href, { headers: { Origin: "https://invalid.example" } })).status, 404);
  const inlineSvg = await session.request.get(href + "?inline=1");
  assert.equal(inlineSvg.status(), 200);
  assert.equal(await inlineSvg.text(), reference);
  assert.equal(inlineSvg.headers()["content-type"], "text/plain; charset=utf-8");
  assert.match(inlineSvg.headers()["content-disposition"]!, /^inline/);
  assert.match(inlineSvg.headers()["content-security-policy"]!, /sandbox/);
  assert.ok(inlineSvg.headers()["content-security-policy"]!.includes(`frame-ancestors ${running.origin}`));
  assert.equal((await session.request.get(href + "?inline=1", { headers: { Origin: "https://invalid.example" } })).status(), 404);
  assert.equal((await session.request.get(changedCapability(href) + "?inline=1")).status(), 404);
  assert.match((await session.request.get(href + "?inline=0")).headers()["content-disposition"]!, /^attachment/);
  const downloaded = page.waitForEvent("download"); await link.click();
  assert.equal(await (await downloaded).failure(), null);
  await row.getByRole("button").click();
  const textViewer = page.locator(`[data-studio-file-viewer="${drawing.id}"]`);
  await textViewer.locator("pre").filter({ hasText: "globalThis.__referenceExecuted" }).waitFor();
  assert.equal(await page.evaluate(() => "__referenceExecuted" in globalThis), false);
  const pdfDrawing = intake.documents.find((document: {path: string}) => document.path === "reference/floor-plan.pdf");
  assert.ok(pdfDrawing);
  const pdfRow = page.locator(`[data-studio-file="${pdfDrawing.id}"]`);
  await pdfRow.getByRole("button").click();
  const pdfUrl = await page.locator(`[data-studio-file-viewer="${pdfDrawing.id}"]`).getByRole("link", { name: /^Download: / }).getAttribute("href"); assert.ok(pdfUrl);
  const inlinePdf = await session.request.get(pdfUrl + "?inline=1");
  assert.equal(inlinePdf.status(), 200);
  assert.deepEqual(await inlinePdf.body(), floorPlanPdf);
  assert.equal(inlinePdf.headers()["content-type"], "application/pdf");
  assert.match(inlinePdf.headers()["content-disposition"]!, /^inline/);
  assert.ok(inlinePdf.headers()["content-security-policy"]!.includes(`frame-ancestors ${running.origin}`));
  await pdfRow.getByRole("button").click();
  const pdfViewer = page.locator(`[data-studio-file-viewer="${pdfDrawing.id}"]`);
  await pdfViewer.locator("iframe").waitFor();
  const pdfDeadline = Date.now() + 15000;
  let pdfFrame: Frame | undefined;
  while (!pdfFrame && Date.now() < pdfDeadline) {
    pdfFrame = page.frames().find(frame => frame.url().startsWith("chrome-extension:"));
    if (!pdfFrame) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(pdfFrame, "Chrome opened its PDF renderer inside the app");
  try {
    await pdfFrame.waitForFunction(() => (document.querySelector("pdf-viewer") as HTMLElement & {loadState_?: string} | null)?.loadState_ === "success", undefined, {timeout: 15000});
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, "file-preview-failed.png") });
    console.error("PDF renderer state", await pdfFrame.evaluate(() => {
      const viewer = document.querySelector("pdf-viewer") as HTMLElement & {loadState_?: string; initialLoadComplete_?: boolean} | null;
      return { loadState: viewer?.loadState_, initialLoadComplete: viewer?.initialLoadComplete_, text: document.body.innerText.slice(0, 500), html: document.body.innerHTML.slice(0, 500) };
    }), [...offMachine]);
    throw error;
  }
  await page.screenshot({ path: path.join(evidence, "file-preview-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await pdfViewer.getByRole("button", { name: "All files", exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "file-preview-narrow.png") });
  await pdfViewer.getByRole("button", { name: "All files", exact: true }).click();
  await pdfRow.getByRole("button").waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  passed("in-app PDF and escaped SVG previews, narrow back navigation and separate download");
  passed("reference UI download, exact bytes and restrictive CSP");
  const note = "Synthetic private note: preserve the 6 by 4 metre room.";
  await section(page, studioText.en.notes); await page.getByLabel(studioText.en.comment).fill(note);
  await page.getByRole("button", { name: "Save note", exact: true }).click(); await page.getByText(note, { exact: true }).waitFor();
  // Sharing lives in the design-line panel and opens as a dialog. The hosted handoff is folded away.
  await page.locator("[data-studio-version]").click();
  await page.getByRole("button", { name: studioText.en.shareProject, exact: true }).click();
  const exportDialog = page.getByRole("dialog");
  await exportDialog.getByRole("button", { name: studioText.en.hostedOptions, exact: true }).click();
  const bundle = path.join(temporary, "handoff");
  await exportDialog.getByRole("textbox", { name: "New destination folder", exact: true }).first().fill(bundle);
  await exportDialog.getByRole("button", { name: "Export handoff", exact: true }).click();
  await exportDialog.locator("pre").filter({ hasText: bundle }).waitFor();
  await page.keyboard.press("Escape");
  const independent = path.join(temporary, "independent-store"); const restored = path.join(temporary, "restored");
  await cli(independent, "import", bundle);
  await cli(independent, "restore", checkpoint, restored);
  assert.equal(await readFile(path.join(restored, "assets/plan.json"), "utf8"), JSON.stringify(plan));
  assert.ok((await cli(independent, "brief", checkpoint)).includes(note));
  const manifest = JSON.parse(await readFile(path.join(restored, "arch.project.json"), "utf8"));
  assert.equal(manifest.name, "Standalone room");
  passed("UI export and independent CLI import, restore, source bytes and private note");
  // The whole project leaves as one file and opens as a new project in another Studio.
  await page.locator("[data-studio-version]").click();
  await page.getByRole("button", { name: studioText.en.shareProject, exact: true }).click();
  const shareDialog = page.getByRole("dialog");
  const [download] = await Promise.all([page.waitForEvent("download"), shareDialog.getByRole("button", { name: studioText.en.saveProjectFile, exact: true }).click()]);
  assert.equal(download.suggestedFilename(), "Standalone room.archproject");
  const projectFile = path.join(temporary, download.suggestedFilename());
  await download.saveAs(projectFile);
  await page.keyboard.press("Escape");
  const receiverHome = path.join(temporary, "receiver-store"); await mkdir(receiverHome, { recursive: true });
  const receiver = await server(receiverHome);
  const receiverSession = await context(receiver.origin); const receiverPage = await receiverSession.newPage();
  await receiverPage.goto(receiver.bootstrapUrl);
  await receiverPage.getByRole("button", { name: studioText.en.openProjectFile, exact: true }).click();
  await receiverPage.getByRole("dialog").locator(`input[type="file"]`).setInputFiles(projectFile);
  // Studio says what the file holds before adding anything.
  await receiverPage.getByRole("dialog").getByText(studioText.en.openProjectTitle.replace("{name}", "Standalone room"), { exact: true }).waitFor();
  await receiverPage.getByRole("dialog").getByRole("button", { name: studioText.en.openProjectAction, exact: true }).click();
  await receiverPage.getByRole("dialog").waitFor({ state: "hidden" });
  await receiverPage.getByText(studioText.en.getStarted, { exact: true }).waitFor();
  await receiverPage.locator("main header").getByText("Standalone room", { exact: false }).first().waitFor();
  assert.equal(await receiverPage.locator("li[data-studio-thread]").count(), 2, "Both conversations travel with the project");
  await receiverPage.screenshot({ path: path.join(evidence, "opened-project.png"), fullPage: true });
  await section(receiverPage, "View project"); await viewer(receiverPage);
  assert.equal(await receiverPage.locator("[data-studio-version]").getAttribute("data-studio-version"), checkpoint, "The opened project shows the same saved version");
  await section(receiverPage, studioText.en.notes); await receiverPage.getByText(note, { exact: true }).waitFor();
  // The builder answers with a note and sends the project back.
  const reply = "Synthetic builder note: the opening needs a lintel.";
  await receiverPage.getByLabel(studioText.en.comment).fill(reply);
  await receiverPage.getByRole("button", { name: "Save note", exact: true }).click(); await receiverPage.getByText(reply, { exact: true }).waitFor();
  await receiverPage.locator("[data-studio-version]").click();
  await receiverPage.getByRole("button", { name: studioText.en.shareProject, exact: true }).click();
  const [returned] = await Promise.all([receiverPage.waitForEvent("download"), receiverPage.getByRole("dialog").getByRole("button", { name: studioText.en.saveProjectFile, exact: true }).click()]);
  const returnedFile = path.join(temporary, "returned.archproject");
  await returned.saveAs(returnedFile);
  await receiverSession.close(); await stop(receiver.child);
  // Opening it where the project already is adds only what is new.
  await page.getByRole("button", { name: studioText.en.addProject, exact: true }).click();
  await page.getByRole("menuitem", { name: studioText.en.openProjectFile, exact: true }).click();
  await page.getByRole("dialog").locator(`input[type="file"]`).setInputFiles(returnedFile);
  await page.getByRole("dialog").getByText(studioText.en.updateProjectTitle.replace("{name}", "Standalone room"), { exact: true }).waitFor();
  await page.getByRole("dialog").getByText(studioText.en.nothingRemoved, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "update-project.png") });
  await page.getByRole("dialog").getByRole("button", { name: studioText.en.updateProjectAction, exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText(studioText.en.getStarted, { exact: true }).waitFor();
  await section(page, studioText.en.notes); await page.getByText(reply, { exact: true }).waitFor(); await page.getByText(note, { exact: true }).waitFor();
  // The same file again has nothing new.
  await page.getByRole("button", { name: studioText.en.addProject, exact: true }).click();
  await page.getByRole("menuitem", { name: studioText.en.openProjectFile, exact: true }).click();
  await page.getByRole("dialog").locator(`input[type="file"]`).setInputFiles(returnedFile);
  await page.getByRole("dialog").getByText(studioText.en.alreadyHaveEverything, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  passed("project file saves from the UI, opens in a fresh Studio with versions, model, conversations and notes, and comes back as an update that only adds");
  await session.close(); await stop(running.child); running = await server(home);
  session = await context(running.origin); page = await session.newPage();
  await page.goto(running.bootstrapUrl);
  // Studio reopens the most recent thread. The main thread holds the reviewed version.
  await page.locator(`li[data-studio-thread="${mainThread}"] [role="button"]`).click();
  await section(page, "View project"); await viewer(page);
  assert.equal(await page.locator("[data-studio-version]").getAttribute("data-studio-version"), checkpoint);
  await section(page, studioText.en.notes); await page.getByText(note, { exact: true }).waitFor();
  assert.ok(await page.locator('[aria-label$=", Standalone room"]').count() >= 1, "The project's threads survive a restart");
  passed("restart preserves project, selected immutable version and private note");
  // Open a separate source while Notes is selected. It must open its own preview,
  // preserve its client, and register without evaluating source code.
  const openedSource = path.join(temporary, "opened-folder");
  await cp(source, openedSource, {recursive: true});
  const openedManifest = JSON.parse(await readFile(path.join(openedSource, "arch.project.json"), "utf8"));
  openedManifest.id = "opened-folder"; openedManifest.name = "Opened folder";
  await writeFile(path.join(openedSource, "arch.project.json"), JSON.stringify(openedManifest));
  const executionMarker = path.join(openedSource, "outputs", "unexpected-execution.txt");
  await writeFile(path.join(openedSource, "source/generate.ts"), `await Bun.write(${JSON.stringify(executionMarker)}, "unexpected source execution"); throw new Error("Opening a folder must never run this.");`);
  await page.getByRole("button", {name: studioText.en.addProject, exact:true}).click();
  await page.getByRole("menuitem", {name: "Open project folder", exact:true}).click();
  let folderDialog = page.getByRole("dialog");
  await folderDialog.getByLabel("Project folder", {exact:true}).fill(openedSource);
  await folderDialog.getByRole("button", {name:"Open",exact:true}).click();
  await folderDialog.waitFor({state:"hidden"});
  await page.locator("main header").getByText("Opened folder", {exact:false}).first().waitFor();
  await page.getByText(studioText.en.getStarted, {exact:true}).waitFor();
  assert.equal(await access(executionMarker).then(()=>true,()=>false),false);
  // The project filter narrows the cross-project thread list to one project and back.
  await page.getByRole("button", {name:"Filter projects",exact:true}).click();
  await page.getByRole("menuitem", {name:"Opened folder",exact:true}).click();
  await page.locator('[aria-label$=", Standalone room"]').waitFor({state:"hidden"});
  await page.locator('[aria-label$=", Opened folder"]').first().waitFor();
  await page.getByRole("button", {name:"Filter projects",exact:true}).click();
  await page.getByRole("menuitem", {name:"All projects",exact:true}).click();
  await page.locator('[aria-label$=", Standalone room"]').first().waitFor();
  // A changed client binding is rejected before the registry is rewritten.
  openedManifest.client = {id:"different-client",name:"Different client"};
  await writeFile(path.join(openedSource,"arch.project.json"),JSON.stringify(openedManifest));
  const beforeRejectedOpen = await cli(home,"list");
  await page.getByRole("button", {name: studioText.en.addProject, exact:true}).click();
  await page.getByRole("menuitem", {name:"Open project folder",exact:true}).click();
  folderDialog=page.getByRole("dialog");
  await folderDialog.getByLabel("Project folder",{exact:true}).fill(openedSource);
  await folderDialog.getByRole("button", {name:"Open",exact:true}).click();
  await folderDialog.getByRole("alert").filter({hasText:"client ID"}).waitFor();
  assert.equal(await cli(home,"list"),beforeRejectedOpen,"Rejected folder must not rewrite its registered source");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({state:"hidden"});
  assert.equal(await page.getByRole("alert").count(),0,"Closing the folder dialog must clear its error");
  passed("folder button submits, selects the source preview, never executes source, preserves client binding, and filters without wrapping");
  await page.getByRole("button", { name: studioText.en.addProject, exact: true }).click();
  await page.getByRole("menuitem", { name: "New project", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project name", { exact: true }).fill("Name only");
  assert.equal(await dialog.getByLabel(studioText.en.startIntake, { exact: false }).count(), 0, "No intake offer without references");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator("main header").getByText("Name only", { exact: false }).first().waitFor();
  assert.equal(await page.locator('[data-studio-round="running"]').count(), 0, "Creating a project never starts a round");
  await section(page, "Files");
  await page.getByText("No references yet.", { exact: false }).waitFor();
  await page.locator('input[type="file"][accept^=".pdf"]').setInputFiles(path.join(inputs, "brief.txt"));
  await page.getByRole("button", { name: "brief.txt", exact: false }).first().waitFor();
  const nameOnly = JSON.parse(await cli(home, "list")).find((project: {manifest: {name: string}}) => project.manifest.name === "Name only");
  assert.deepEqual(nameOnly.manifest.references.map((reference: {path: string}) => reference.path), ["reference/brief.txt"]);
  passed("name-only project starts idle and takes references later as a new version");
  await page.getByRole("button", { name: "Filter projects", exact: true }).click();
  await page.getByRole("menuitem", { name: studioText.en.newClient, exact: true }).click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByRole("textbox").count(), 1, "Clients need only a name");
  await dialog.getByLabel(studioText.en.clientName, { exact: true }).fill("Lindenhof Wohnbau");
  await dialog.getByRole("button", { name: studioText.en.newClient, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Filter projects", exact: true }).getByText("Lindenhof Wohnbau", { exact: true }).waitFor();
  passed("clients are created from a name alone");
  // A stopped round saves the folder as it is: changed sources next to the previous build's model.
  // That version is unbuilt changes, and the project still opens on its last real model.
  await writeFile(path.join(source, "assets/plan.json"), JSON.stringify({ ...plan, name: "Changed by a stopped round" }));
  await cli(home, "continue", source);
  await page.reload();
  await page.locator(`li[data-studio-thread="${mainThread}"] [role="button"]`).click();
  await page.locator('[data-studio-view="rounds"]:visible').click();
  await page.getByText(studioText.en.unbuiltChanges, { exact: true }).first().waitFor();
  assert.equal(await page.getByText("Artifact checkpoint integrity failure", { exact: false }).count(), 0, "A stale saved model must not break the project");
  await section(page, "View project"); await viewer(page);
  assert.equal(await page.locator("[data-studio-version]").getAttribute("data-studio-version"), checkpoint, "The project opens on its last real model");
  passed("a version saved with a stale model counts as unbuilt changes and never blocks the project");
  assert.deepEqual([...offMachine], [], "App attempted off-machine network access");
  passed("zero off-machine app requests");
  await writeFile(path.join(evidence, "checks.json"), JSON.stringify({ ok: true, checks, screenshots: ["desktop.png", "opened-project.png", "update-project.png", "narrow.png", "intake-desktop.png", "intake-narrow.png", "intake-invalid.png", "file-preview-desktop.png", "file-preview-narrow.png", "compare.png"] }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, evidence }));
} catch (error) {
  await mkdir(evidence, { recursive: true });
  await failurePage?.().screenshot({ path: path.join(evidence, "failure.png") }).catch(() => undefined);
  await writeFile(path.join(evidence, "checks.json"), JSON.stringify({ ok: false, checks, error: error instanceof Error ? error.message : "Verification failed", offMachine: [...offMachine] }, null, 2));
  console.error(error instanceof Error ? error.stack : "Verification failed"); process.exitCode = 1;
} finally {
  await cleanup();
}
