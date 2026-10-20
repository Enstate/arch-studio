import { randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, getRequest, setCookie } from "@tanstack/react-start/server";

const cookie = "arch-studio-session";
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
function valid(value: string | undefined) {
  return Boolean(value && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(secret)));
}
export async function session() {
  studioOrigin(getRequest());
  setCookie(cookie, secret, { httpOnly: true, sameSite: "strict", path: "/" });
  return { local: true as const };
}
export function requireStudio(request?: Request) {
  const current = request ?? getRequest();
  const origin = studioOrigin(current);
  const value = request ? current.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookie}=`))?.slice(cookie.length + 1) : getCookie(cookie);
  if (!valid(value)) throw new Error("Open Studio to initialize this local session.");
  return origin;
}
