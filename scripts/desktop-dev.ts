import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const port = process.env.ARCH_STUDIO_PORT ?? '3101';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid Studio port');
const origin = `http://127.0.0.1:${port}`;
const children: ReturnType<typeof spawn>[] = [];
function cleanup() { for (const child of children) { try { process.kill(-child.pid!, 'SIGTERM'); } catch {} } }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
try {
  try { await fetch(origin); throw new Error(`Port ${port} is occupied. Choose a free ARCH_STUDIO_PORT.`); } catch (error) { if (!(error instanceof TypeError)) throw error; }
  const studio = spawn(process.execPath, ['run', 'dev'], { cwd: root, env: { ...process.env, ARCH_STUDIO_PORT: port }, stdio: 'inherit', detached: true });
  children.push(studio);
  let exited = false;
  studio.on('exit', () => { exited = true; cleanup(); process.exitCode = 1; });
  const deadline = Date.now() + 60000;
  for (;;) {
    if (exited || Date.now() > deadline) throw new Error('Studio did not become ready');
    try { const response = await fetch(origin); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const require = createRequire(resolve(root, 'apps/desktop/package.json'));
  const electron = spawn(require('electron'), [resolve(root, 'apps/desktop')], { cwd: root, env: { ...process.env, ARCH_STUDIO_DEV_ORIGIN: origin }, stdio: 'inherit', detached: true });
  children.push(electron);
  await new Promise<void>((done, reject) => { electron.once('exit', () => done()); electron.once('error', reject); });
} finally { cleanup(); }
