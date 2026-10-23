import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendStudioLog, studioLogLine } from "./studio-log.server";

test("a log line keeps the code and message but not URLs, tokens or the home folder", () => {
  const home = "/Users/tester";
  const token = "b".repeat(64);
  const error = new Error(`Export failed at http://127.0.0.1:3101/api/artifacts/${token}/${token}/plan.json, Bearer ${token}, in ${home}/Library/Application Support/Arch Studio`);
  error.stack = `Error: ${error.message}\n${Array.from({ length: 40 }, (_, index) => `    at frame${index} (${home}/arch/studio.ts:${index}:1)`).join("\n")}`;
  const line = studioLogLine("projectDetails", error, {}, new Date("2026-10-22T10:00:00.000Z"), home);
  expect(line.endsWith("\n")).toBe(true);
  const entry = JSON.parse(line) as Record<string, string>;
  expect(entry).toMatchObject({ time: "2026-10-22T10:00:00.000Z", source: "projectDetails", code: null, name: "Error" });
  expect(JSON.parse(studioLogLine("buildVersion", new Error("ARCH_PROJECT_BUSY"))).code).toBe("ARCH_PROJECT_BUSY");
  expect(line).not.toContain(token);
  expect(line).not.toContain("127.0.0.1");
  expect(line).not.toContain(home);
  expect(entry.message).toContain("~/Library/Application Support/Arch Studio");
  // The stack keeps a dozen frames, without the message line it repeats.
  expect(entry.stack!.split("\n")).toHaveLength(12);
  expect(JSON.parse(studioLogLine("failed round", "x".repeat(10_000), { round: "r1" })).message).toHaveLength(4000);
});

test("the log rotates past its limit and keeps one previous file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arch-log-"));
  try {
    const file = path.join(directory, "logs", "studio.log");
    const line = (index: number) => `${JSON.stringify({ index, padding: "p".repeat(80) })}\n`;
    for (let index = 0; index < 30; index++) await appendStudioLog(file, line(index), 1024);
    const current = await readFile(file, "utf8");
    const previous = await readFile(`${file}.1`, "utf8");
    expect((await stat(file)).size).toBeLessThanOrEqual(1024);
    expect((await stat(`${file}.1`)).size).toBeLessThanOrEqual(1024);
    expect(current.trimEnd().split("\n").at(-1)).toBe(line(29).trimEnd());
    // Lines older than the previous file are gone; nothing is split across files.
    expect(previous.trimEnd().split("\n").map(item => (JSON.parse(item) as { index: number }).index).at(-1)! + 1).toBe((JSON.parse(current.split("\n")[0]!) as { index: number }).index);
    expect(previous.includes(line(0))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
