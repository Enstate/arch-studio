import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registerProject,
  startPreview,
  stopPreview,
  stopPreviews,
} from "../src/index.ts";

test("preview leases isolate consumers and serve restricted streaming assets", async () => {
  const sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "arch-previews-")),
  );
  const oldHome = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(sandbox, "store");
  const directory = path.join(sandbox, "project");
  const manifest = {
    schemaVersion: 1,
    id: "pilot",
    name: "Pilot",
    client: { id: "client", name: "Client" },
    description: "Fixture",
    entry: "index.html",
    runtime: { name: "three", version: "0.186.1", templateVersion: "0.1.0" },
    views: [{ id: "living", label: "Living", piece: "living" }],
    assumptions: [],
    references: [],
  };
  const brief = {
    goal: "One-level pilot",
    driver: "Lead",
    decisions: ["Keep fixed views"],
    unresolved: ["Finish critique"],
    nextAction: "Review living room",
    instructionVersion: "1",
  };
  try {
    await fs.mkdir(path.join(directory, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "arch.project.json"),
      JSON.stringify(manifest),
    );
    await fs.writeFile(
      path.join(directory, "arch.context.json"),
      JSON.stringify(brief),
    );
    await fs.writeFile(
      path.join(directory, "index.html"),
      "<html><head></head><body>Fixture</body></html>",
    );
    await fs.writeFile(path.join(directory, ".env"), "SECRET");
    await fs.writeFile(path.join(directory, "assets/movie.mp4"), "0123456789");
    const dependencies = { three: "0.186.1" };
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "pilot", dependencies }),
    );
    await fs.writeFile(
      path.join(directory, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "pilot", dependencies },
          "node_modules/three": {
            version: "0.186.1",
            resolved: "https://registry.npmjs.org/three/-/three-0.186.1.tgz",
            integrity: "sha512-fixture",
          },
        },
      }),
    );
    await registerProject(directory);
    const [first, second] = await Promise.all([
      startPreview("pilot"),
      startPreview("pilot"),
    ]);
    expect(first.url).not.toBe(second.url);
    await stopPreview(first.url);
    const page = await fetch(second.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    await page.text();
    expect((await fetch(new URL("/", second.url))).status).toBe(404);
    expect((await fetch(new URL(".env", second.url))).status).toBe(404);
    const runtime = await fetch(
      new URL("node_modules/three/build/three.module.js", second.url),
    );
    expect(runtime.status).toBe(200);
    await runtime.text();
    const video = await fetch(new URL("assets/movie.mp4", second.url), {
      headers: { Range: "bytes=2-5" },
    });
    expect(video.status).toBe(206);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(video.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await video.text()).toBe("2345");
    const invalidRange = await fetch(new URL("assets/movie.mp4", second.url), {
      headers: { Range: "bytes=99-" },
    });
    expect(invalidRange.status).toBe(416);
    const leases = await Promise.allSettled(
      Array.from({ length: 10 }, () => startPreview("pilot")),
    );
    expect(leases.filter((lease) => lease.status === "fulfilled")).toHaveLength(
      7,
    );
    await stopPreviews();
    const pending = startPreview("pilot");
    const stopping = stopPreviews();
    const last = await pending;
    await stopping;
    await expect(fetch(last.url)).rejects.toThrow();
    const reopened = await startPreview("pilot");
    const reopenedPage = await fetch(reopened.url);
    expect(reopenedPage.status).toBe(200);
    await reopenedPage.text();
  } finally {
    await stopPreviews();
    if (oldHome === undefined) delete process.env.ARCH_HOME;
    else process.env.ARCH_HOME = oldHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
