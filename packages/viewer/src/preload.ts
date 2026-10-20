import { capabilities } from './capabilities.ts';

const prefetched = new Map<string, Promise<Response>>();
const key = (url: string | URL) => new URL(url, location.href).href;

function prefetch(url: string | URL) {
  const k = key(url);
  if (prefetched.has(k)) return;
  const res = fetch(k);
  res.catch(() => prefetched.delete(k));
  prefetched.set(k, res);
}

/**
 * Starts what the first frame waits for: the three.js chunk, the capability check, the plan and the
 * library index. Safe to call often and on the server.
 */
export function preloadViewer(opts: { planUrl?: string | null; assetBase?: string } = {}) {
  if (typeof window === 'undefined') return;
  void capabilities();
  void import('./viewer.ts');
  if (opts.assetBase) prefetch(new URL('index.json', new URL(opts.assetBase.endsWith('/') ? opts.assetBase : `${opts.assetBase}/`, location.href)));
  if (opts.planUrl) prefetch(opts.planUrl);
}

/** A response preloadViewer started for `url`, handed out once so a retry fetches fresh. */
export function takePrefetched(url: string | URL): Promise<Response> | undefined {
  const k = key(url);
  const res = prefetched.get(k);
  prefetched.delete(k);
  return res;
}
