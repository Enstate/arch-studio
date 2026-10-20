import { randomBytes } from "node:crypto";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({mode, command}) => {
  const environment = {...loadEnv(mode, process.cwd(), ""), ...process.env};
  if (environment.CONVEX_DEPLOY_KEY) throw new Error("Start local Studio without a Convex deploy key.");
  const rawPort = environment.ARCH_STUDIO_PORT ?? "3101";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error("ARCH_STUDIO_PORT must be an integer between 1 and 65535.");
  // This value stays in the server process. It is never a VITE_ client variable.
  const bootstrap = randomBytes(32).toString("hex");
  process.env.ARCH_STUDIO_BOOTSTRAP = bootstrap;
  return {
    server: {host: "127.0.0.1", port: Number(rawPort), strictPort: true, cors: false, fs: {deny: ["**/.env*", "**/.git/**", "**/.arch/**", "**/evidence/**"]}},
    preview: {host: "127.0.0.1", port: Number(rawPort), strictPort: true},
    resolve: {tsconfigPaths: true},
    // The desktop server is compiled without an installed node_modules tree.
    ssr: {noExternal: command === "build" ? true : undefined},
    plugins: [tailwindcss(), tanstackStart(), react(), {
      name: "arch-local-pairing",
      configureServer(server) {
        server.httpServer?.once("listening", () => {
          console.log(`\nOpen Arch Studio: http://127.0.0.1:${rawPort}/#studio=${bootstrap}\n`);
        });
      },
      configurePreviewServer(server) {
        server.httpServer.once("listening", () => {
          console.log(`\nOpen Arch Studio: http://127.0.0.1:${rawPort}/#studio=${bootstrap}\n`);
        });
      },
    }],
  };
});
