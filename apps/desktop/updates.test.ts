import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { createDesktopUpdates } = createRequire(import.meta.url)("./updates.cjs");

async function subject() {
  const home = await mkdtemp(path.join(tmpdir(), "arch-update-test-"));
  await writeFile(path.join(home, "app-update.yml"), "provider: github\n");
  const events: string[] = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: async (): Promise<unknown> => { events.push("check"); updater.emit("update-available", { version: "0.1.4" }); },
    downloadUpdate: async (): Promise<unknown> => { events.push("download"); updater.emit("update-downloaded", { version: "0.1.4" }); },
    quitAndInstall: () => { events.push("install"); },
  });
  const states: unknown[] = [];
  const options = {
    app: { isPackaged: true, getVersion: () => "0.1.3", getPath: () => home, relaunch: () => { events.push("relaunch"); }, quit: () => { events.push("quit"); } },
    updater, publish: (state: unknown) => states.push(state), resourcesPath: home,
    beforeInstall: async () => { events.push("pause-studio"); },
    recoverInstall: async () => { events.push("resume-studio"); },
  };
  const controller = createDesktopUpdates(options);
  return { home, updater, events, states, controller, options };
}
async function fixture(run: (value: Awaited<ReturnType<typeof subject>>) => Promise<void>) {
  const value = await subject();
  try { await run(value); }
  finally { value.controller.dispose(); await rm(value.home, { recursive: true, force: true }); }
}

test("checking never downloads; installation requires explicit download and pauses Studio before native installation", () => fixture(async ({ home, updater, events, controller }) => {
  expect(updater.autoDownload).toBe(false);
  expect(updater.autoInstallOnAppQuit).toBe(false);
  await controller.install(); expect(events).toEqual([]);
  await controller.check(); expect(events).toEqual(["check"]);
  await controller.install(); expect(events).toEqual(["check"]);
  await controller.download(); expect(controller.getState().status).toBe("downloaded");
  await controller.check(); expect(controller.getState().status).toBe("downloaded");
  await controller.install(); expect(events).toEqual(["check", "download", "pause-studio", "install"]);
  expect(JSON.parse(await readFile(path.join(home, "update-install.json"), "utf8"))).toEqual({ fromVersion: "0.1.3", targetVersion: "0.1.4" });
}));

test("interrupted download retains its version and can be retried", () => fixture(async ({ updater, controller }) => {
  await controller.check();
  updater.downloadUpdate = async () => { updater.emit("error", new Error("network lost")); throw new Error("network lost"); };
  await controller.download(); expect(controller.getState()).toMatchObject({ status: "available", version: "0.1.4", operation: "download" });
  updater.downloadUpdate = async () => updater.emit("update-downloaded", { version: "0.1.4" });
  await controller.download(); expect(controller.getState().status).toBe("downloaded");
}));

test("asynchronous installer errors restore Studio and preserve the downloaded update", () => fixture(async ({ updater, events, controller }) => {
  await controller.check(); await controller.download(); await controller.install();
  updater.emit("error", new Error("installer refused"));
  for (let attempt = 0; attempt < 30 && controller.getState().status === "installing"; attempt++) await Bun.sleep(10);
  expect(events).toContain("resume-studio");
  expect(controller.getState()).toMatchObject({ status: "downloaded", operation: "install", version: "0.1.4" });
}));

test("an unfinished installation is reported on the next launch", () => fixture(async ({ home, options }) => {
  await writeFile(path.join(home, "update-install.json"), JSON.stringify({ fromVersion: "0.1.3", targetVersion: "0.1.4" }));
  const restarted = createDesktopUpdates(options);
  try { await restarted.start(); expect(restarted.getState()).toMatchObject({ status: "error", operation: "check" }); }
  finally { restarted.dispose(); }
}));

test("overlapping checks are serialized and preview builds cannot update", () => fixture(async ({ updater, controller, options, events }) => {
  let finish: () => void = () => {};
  updater.checkForUpdates = () => new Promise<void>(resolve => { finish = resolve; events.push("check"); });
  const pending = controller.check(); await controller.check(); expect(events).toEqual(["check"]); finish(); await pending;
  const preview = createDesktopUpdates({ ...options, app: { ...options.app, isPackaged: false } });
  try { await preview.check(); await preview.download(); await preview.install(); expect(preview.getState().status).toBe("disabled"); expect(events).toEqual(["check"]); }
  finally { preview.dispose(); }
}));

test("background failures stay quiet and an available download is not interrupted", () => fixture(async ({ updater, controller, events }) => {
  updater.checkForUpdates = async () => { throw new Error("offline"); };
  await controller.check("background"); expect(controller.getState()).toEqual({ currentVersion: "0.1.3", status: "idle" });
  updater.checkForUpdates = async () => { events.push("check"); updater.emit("update-available", { version: "0.1.4" }); };
  await controller.check();
  await controller.check("background"); expect(events).toEqual(["check"]); expect(controller.getState().status).toBe("available");
}));

test("failed Studio recovery relaunches instead of leaving a disabled window", () => fixture(async ({ options, events, updater }) => {
  const controller = createDesktopUpdates({ ...options, recoverInstall: async () => { throw new Error("window unavailable"); } });
  try {
    await controller.check(); await controller.download(); await controller.install();
    updater.emit("error", new Error("installer refused"));
    for (let attempt = 0; attempt < 30 && !events.includes("relaunch"); attempt++) await Bun.sleep(10);
    expect(events.slice(-2)).toEqual(["relaunch", "quit"]);
  } finally { controller.dispose(); }
}));
