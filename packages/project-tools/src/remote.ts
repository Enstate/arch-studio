/** Requests to the public asset catalogs Studio imports from. */

const TIMEOUT = 60_000;
export const MB = 1024 * 1024;

/**
 * The body of a request, at most `maxBytes` long. The request and each redirect must go over
 * HTTPS to a host `allowed` accepts, so a response can never point Studio at a local service.
 */
export async function fetchCapped(url: string, maxBytes: number, allowed: (url: URL) => boolean, { signal, ...init }: RequestInit & { signal?: AbortSignal } = {}): Promise<{ bytes: Uint8Array; type: string }> {
  const timeout = AbortSignal.timeout(TIMEOUT);
  let target = new URL(url);
  let response: Response | undefined;
  for (let hop = 0; hop < 6; hop++) {
    if (target.protocol !== "https:" || !allowed(target)) throw new Error(`Refusing to fetch ${target.host}.`);
    response = await fetch(target, { ...init, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { "User-Agent": "Arch Studio", ...init.headers } });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) break;
    target = new URL(location, target);
    if (init.method && init.method !== "GET") throw new Error(`Unexpected redirect from ${new URL(url).host}.`);
  }
  if (!response?.ok) throw new Error(`${response?.status ?? "No"} ${response?.statusText ?? "response"} from ${target.host}`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error(`${target.host} sent more than ${maxBytes} bytes.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > maxBytes) throw new Error(`${target.host} sent more than ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  chunks.reduce((at, chunk) => {
    bytes.set(chunk, at);
    return at + chunk.length;
  }, 0);
  return { bytes, type: response.headers.get("content-type") ?? "" };
}
