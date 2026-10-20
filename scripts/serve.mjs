import studio from '../apps/studio/dist/server/server.js';
import { resolve, sep } from 'node:path';
import { stat, realpath } from 'node:fs/promises';
const client = resolve(process.env.ARCH_CLIENT_ROOT ?? new URL('../apps/studio/dist/client', import.meta.url).pathname);
const rawPort = process.env.ARCH_STUDIO_PORT ?? '0';
if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Invalid ARCH_STUDIO_PORT');
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(rawPort),
  async fetch(request) {
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
    const segments = pathname.split('/');
    if (segments.some(part => part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return new Response('Not found', { status: 404 });
    const path = resolve(client, '.' + pathname);
    if (path.startsWith(client + sep) && ['GET', 'HEAD'].includes(request.method)) {
      try {
        if ((await realpath(path)).startsWith(client + sep) && (await stat(path)).isFile()) return new Response(request.method === 'HEAD' ? null : Bun.file(path), { headers: { 'Content-Type': Bun.file(path).type } });
      } catch {}
    }
    return studio.fetch(request);
  },
});
console.log(JSON.stringify({ archStudioReady: true, origin: server.url.origin }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.stop(true); process.exit(0); });
