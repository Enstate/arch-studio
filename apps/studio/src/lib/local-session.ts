import { randomBytes, timingSafeEqual } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";
import { studioSessionHeader } from "./browser-session";

const secret = randomBytes(32).toString("hex");
export function studioOrigin(request: Request) {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Studio requires HTTP loopback.");
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new Error("Cross-origin Studio requests are refused.");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new Error("Cross-site Studio requests are refused.");
  return url.origin;
}
function valid(value: string | null | undefined, expected = secret) {
  return Boolean(value && /^[a-f0-9]{64}$/.test(value) && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected)));
}
export async function session({ token }: { token?: string } = {}) {
  const request = getRequest();
  studioOrigin(request);
  if (!valid(request.headers.get(studioSessionHeader)) && !valid(token, process.env.ARCH_STUDIO_BOOTSTRAP ?? "")) {
    throw new Error("Open the Studio link printed in your terminal. Öffne den Studio-Link aus deinem Terminal.");
  }
  return { local: true as const, secret };
}
export function requireStudio(request?: Request) {
  const current = request ?? getRequest();
  const origin = studioOrigin(current);
  if (!valid(current.headers.get(studioSessionHeader))) throw new Error("Open the Studio link printed in your terminal.");
  return origin;
}
