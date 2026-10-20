/** Actual paired Studio regression: slow motion must settle into a sharp, idle frame. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const label = process.argv[2] ?? "after";
if (!["before", "after"].includes(label)) throw new Error("Use before or after");
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "arch-quality-")));
const evidence = path.join(root, "evidence/viewer-quality");
const children = new Set<ChildProcess>();
let browser: Browser | undefined;
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
async function command(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let diagnostic = "";
  child.stdout!.resume(); child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(code, 0, diagnostic);
}
async function ready(page: Page) {
  await page.locator('[data-studio-preview="ready"]').waitFor({timeout: 30000}).catch(async error => { console.error((await page.content()).slice(0, 1200)); throw error; });
  await page.getByRole("progressbar").waitFor({state: "hidden", timeout: 30000});
  await page.waitForFunction(() => Boolean((window as unknown as {__arch?: unknown}).__arch));
}
try {
  await mkdir(evidence, {recursive: true});
  const env = {...process.env, ARCH_HOME: path.join(temporary, "store")};
  if (process.env.ARCH_QUALITY_LEGACY_BUNDLE) {
    const bundle = path.resolve(process.env.ARCH_QUALITY_LEGACY_BUNDLE);
    const checkpoint = JSON.parse(await readFile(path.join(bundle, "checkpoint.json"), "utf8"));
    await command(["packages/project-tools/src/cli.ts", "import", bundle], env);
    await command(["packages/project-tools/src/cli.ts", "restore", checkpoint.id, path.join(temporary, "source"), "--activate"], env);
  } else await command(["scripts/demo.ts"], env);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const server = spawn(process.execPath, ["run", "--cwd", "apps/studio", "dev"], {cwd: root, env: {...env, ARCH_STUDIO_PORT: String(port)}, stdio: ["ignore", "pipe", "pipe"]});
  children.add(server); server.stderr!.resume();
  const bootstrap = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Studio startup timed out")), 30000);
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Studio exited: ${code}`)); });
    server.stdout!.on("data", chunk => {
      output += String(chunk);
      const link = output.match(/http:\/\/127\.0\.0\.1:\d+\/#studio=[a-f0-9]{64}/)?.[0];
      if (link) { clearTimeout(timeout); resolve(link); }
    });
  });
  browser = await chromium.launch({executablePath: process.env.ARCH_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--enable-unsafe-swiftshader"]});
  const context = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, colorScheme: "light"});
  await context.addCookies([{name: "arch-locale", value: "en", url: new URL(bootstrap).origin}]);
  const page = await context.newPage();
  page.on("pageerror", error => console.error("Page error:", error.message));
  page.on("console", message => { if (message.type() === "error") console.error("Browser:", message.text()); });
  await page.goto(bootstrap); await ready(page);
  // Inject only a slow-frame history. The real renderer/controller performs the downshift.
  const reduced = await page.evaluate(() => {
    const {stage, viewer} = (window as unknown as {__arch: {stage: {frameTimes: number[]; requestRender(): void; renderIfNeeded(now: number): void}; viewer: {stats(): {renderScale: number}}}}).__arch;
    for (let step = 0; step < 4; step++) { stage.frameTimes = Array(40).fill(50); stage.requestRender(); stage.renderIfNeeded(performance.now()); }
    return viewer.stats().renderScale;
  });
  assert.equal(reduced, 0.6, "Synthetic slow motion must exercise the lowest render scale");
  await page.waitForTimeout(800);
  const idle = await page.evaluate(() => {
    const {stage, viewer} = (window as unknown as {__arch: {stage: {renderer: {info: {calls: number}}}; viewer: {stats(): {renderScale: number; quality: string; backend: string}}}}).__arch;
    const canvas = document.querySelector("[data-viewer] canvas") as HTMLCanvasElement;
    return {...viewer.stats(), frame: stage.renderer.info.calls, bufferRatio: canvas.width / canvas.getBoundingClientRect().width};
  });
  await page.screenshot({path: path.join(evidence, `${label}.png`)});
  console.log(JSON.stringify({label, injectedSlowMotionScale: reduced, idle}, null, 2));
  assert.equal(idle.renderScale, 1, "A stopped camera must restore full internal resolution");
  assert.ok(idle.bufferRatio >= 1.99, "Retina desktop must retain a 2x drawing buffer");
  await page.waitForTimeout(250);
  const frame = await page.evaluate(() => (window as unknown as {__arch: {stage: {renderer: {info: {calls: number}}}}}).__arch.stage.renderer.info.calls);
  assert.equal(frame, idle.frame, "The sharp idle view must stop drawing");
  const resumed = await page.evaluate(() => {
    const {stage, viewer} = (window as unknown as {__arch: {stage: {requestRender(): void; renderIfNeeded(now?: number): void; gtao: {resolutionScale: number}}; viewer: {stats(): {renderScale: number}}}}).__arch;
    const now = performance.now();
    stage.requestRender(); stage.renderIfNeeded(now); stage.renderIfNeeded(now + 1);
    stage.renderIfNeeded(now + 17);
    return {scale: viewer.stats().renderScale, aoScale: stage.gtao.resolutionScale};
  });
  assert.equal(resumed.scale, 0.6, "A brief input gap must retain the previous adaptive resolution");
  assert.equal(resumed.aoScale, 0.5, "Movement must recover inexpensive AO");
  const mobile = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36"});
  const phone = await mobile.newPage(); await phone.goto(bootstrap); await ready(phone);
  const phoneQuality = await phone.evaluate(() => {
    const canvas = document.querySelector("[data-viewer] canvas") as HTMLCanvasElement;
    return {quality: (window as unknown as {__arch: {viewer: {stats(): {quality: string}}}}).__arch.viewer.stats().quality, bufferRatio: canvas.width / canvas.getBoundingClientRect().width};
  });
  assert.equal(phoneQuality.quality, "lite");
  assert.ok(phoneQuality.bufferRatio <= 1.25, "Phone drawing buffer must retain the existing cap");
  console.log(JSON.stringify({ok: true, phoneQuality, checks: ["real paired furnished scene", "slow-motion downshift", "full-resolution settled frame", "2x desktop buffer", "no repeated idle drawing", "unchanged mobile cap"]}));
} finally {
  await browser?.close();
  await Promise.all([...children].map(stop));
  await rm(temporary, {recursive: true, force: true});
}
