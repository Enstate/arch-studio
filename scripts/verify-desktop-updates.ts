import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from '../apps/desktop/update-state';
import { _electron, chromium, type ElectronApplication, type Browser } from 'playwright-core';
import { stringify } from 'yaml';
import { withSigningKeychain } from './desktop-signing';

// This tests real Squirrel replacement using two signed synthetic versions.
// Only the copies below receive the loopback feed and isolated-store bootstrap.
if (process.platform !== 'darwin') throw new Error('Native macOS update verification requires macOS.');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'arch-native-update-')));
const profile = join(temporary, 'profile');
const home = join(temporary, 'store');
const launch = join(temporary, 'launch.json');
const cacheName = `arch-studio-update-test-${randomUUID()}`;
const candidate = process.argv[2] ?? join(root, `artifacts/arch-studio-darwin-${process.arch}/mac${process.arch === 'arm64' ? '-arm64' : ''}/Arch Studio.app`);
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const asarRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asar = asarRequire('@electron/asar') as { extractAll(path: string, directory: string): void; createPackage(directory: string, path: string): Promise<void> };
function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) {
    let detail = result.stderr;
    for (const [name, secret] of Object.entries(process.env)) if (/KEY|PASSWORD|TOKEN/.test(name) && secret && secret.length > 4) detail = detail.replaceAll(secret, '[redacted]');
    throw new Error(`Native update fixture command failed: ${command} (${result.status}): ${detail.slice(0, 1500)}`);
  }
  return result.stdout;
}
await mkdir(profile);
const env = Object.fromEntries(Object.entries({ ...process.env, ARCH_HOME: home }).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
const storeSource = join(home, 'examples/sample-house/arch.project.json');
let originalSource: Buffer;
const zipName = `Arch-Studio-0.0.2-${process.arch}.zip`;
let zip: Buffer | undefined;
let feedRequests = 0;
let payloadRequests = 0;
const feed = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/latest-mac.yml' && zip) {
    feedRequests++;
    const sha512 = createHash('sha512').update(zip).digest('base64');
    response.setHeader('Content-Type', 'application/yaml');
    response.end(stringify({ version: '0.0.2', files: [{ url: zipName, sha512, size: zip.length }], path: zipName, sha512 }));
  } else if (pathname === `/${zipName}` && zip) {
    payloadRequests++; response.setHeader('Content-Type', 'application/zip'); response.setHeader('Content-Length', zip.length); response.end(zip);
  } else { response.writeHead(404); response.end('Not found'); }
});
await new Promise<void>(resolve => feed.listen(0, '127.0.0.1', resolve));
const address = feed.address();
assert(address && typeof address !== 'string');
const feedOrigin = `http://127.0.0.1:${address.port}`;
let electron: ElectronApplication | undefined;
let browser: Browser | undefined;
let oldOrigin: string | undefined;
let newOrigin: string | undefined;
let completed = false;
async function wait<T>(read: () => Promise<T>, accept: (value: T) => boolean, milliseconds = 90_000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; } catch {}
    await delay(200);
  }
  throw new Error('Native update fixture timed out');
}
try {
  run(process.execPath, ['scripts/demo.ts'], env);
  originalSource = await readFile(storeSource);
  const bundle = join(temporary, 'desktop-main.cjs');
  run(process.execPath, ['build', join(root, 'apps/desktop/main.cjs'), '--target=node', '--format=cjs', '--external=electron', '--outfile', bundle]);
  const main = await readFile(bundle, 'utf8');
  const bootstrap = `const archUpdateFixture = require('electron');\nprocess.env.ARCH_HOME=${JSON.stringify(home)};\narchUpdateFixture.app.setPath('userData',${JSON.stringify(profile)});\narchUpdateFixture.app.commandLine.appendSwitch('remote-debugging-port','0');\narchUpdateFixture.app.whenReady().then(()=>require('node:fs').writeFileSync(${JSON.stringify(launch)},JSON.stringify({pid:process.pid,version:archUpdateFixture.app.getVersion()}),{mode:384}));\n`;
  await withSigningKeychain(async () => {
    const identities = run('security', ['find-identity', '-v', '-p', 'codesigning', process.env.CSC_KEYCHAIN!]);
    const identity = identities.match(/([A-F0-9]{40}) "Developer ID Application:/)?.[1];
    assert(identity, 'Fixture requires Developer ID signing');
    for (const [folder, version] of [['installed', '0.0.1'], ['target', '0.0.2']]) {
      const application = join(temporary, folder!, 'Arch Studio.app');
      await mkdir(join(temporary, folder!));
      await cp(candidate, application, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      const resources = join(application, 'Contents/Resources');
      const unpacked = join(temporary, `${folder}-source`);
      asar.extractAll(join(resources, 'app.asar'), unpacked);
      const manifestPath = join(unpacked, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.version = version;
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(join(unpacked, 'main.cjs'), bootstrap + main);
      await asar.createPackage(unpacked, join(resources, 'app.asar'));
      await writeFile(join(resources, 'app-update.yml'), stringify({ provider: 'generic', url: feedOrigin, updaterCacheDirName: cacheName }));
      const plist = join(application, 'Contents/Info.plist');
      for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${version}`, plist]);
      run('codesign', ['--force', '--sign', identity!, '--keychain', process.env.CSC_KEYCHAIN!, '--options', 'runtime', '--timestamp', '--entitlements', join(root, 'apps/desktop/entitlements.mac.plist'), application]);
      run('codesign', ['--verify', '--deep', '--strict', application]);
    }
  });
  console.log('PASS signed synthetic app fixtures created');
  const installed = join(temporary, 'installed/Arch Studio.app');
  const archive = join(temporary, zipName);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(temporary, 'target/Arch Studio.app'), archive]);
  zip = await readFile(archive);
  electron = await _electron.launch({ executablePath: join(installed, 'Contents/MacOS/Arch Studio'), args: [`--user-data-dir=${profile}`], env });
  const page = await electron.firstWindow();
  await page.getByRole('button', { name: 'Sample house', exact: true }).waitFor();
  await page.locator('[data-studio-preview="ready"]').waitFor({ timeout: 60_000 });
  oldOrigin = new URL(page.url()).origin;
  const oldLaunch = JSON.parse(await readFile(launch, 'utf8'));
  assert.equal(oldLaunch.version, '0.0.1');
  const checkpoint = await page.getByLabel(/^(Versions|Versionen)$/).inputValue();
  const refused = await electron.evaluate(async ({ BrowserWindow }, preload) => {
    const alien = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload } });
    try { await alien.loadURL('data:text/html,<title>Untrusted update caller</title>'); return await alien.webContents.executeJavaScript('window.archDesktop.getUpdateState().then(()=>false,()=>true)'); }
    finally { alien.destroy(); }
  }, join(installed, 'Contents/Resources/app.asar/preload.cjs'));
  assert.equal(refused, true, 'Another window must not invoke the updater');
  console.log('PASS real preload bridge and untrusted-window denial');
  assert.equal((await page.evaluate(() => window.archDesktop!.checkForUpdate())).status, 'available');
  await page.locator('[data-desktop-update="available"]').waitFor();
  await mkdir(join(root, 'evidence/desktop-updates'), { recursive: true });
  await page.screenshot({ path: join(root, 'evidence/desktop-updates/available.png'), scale: 'device' });
  await page.getByRole('button', { name: /^(Download update|Update herunterladen)$/ }).click();
  await page.locator('[data-desktop-update="downloaded"]').waitFor({ timeout: 90_000 });
  assert(feedRequests > 0 && payloadRequests > 0, 'Real updater must fetch the feed and signed ZIP');
  console.log('PASS real signed update download');
  const restart = page.locator('[data-desktop-update="downloaded"]').getByRole('button', { name: /^(Restart and install|Neu starten und installieren)$/ });
  await restart.click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Cancel|Abbrechen)$/ }).click();
  assert.equal((await page.evaluate(() => window.archDesktop!.getUpdateState())).status, 'downloaded');
  await restart.click();
  await page.screenshot({ path: join(root, 'evidence/desktop-updates/restart-confirmation.png'), scale: 'device' });
  const exited = new Promise<void>(resolve => electron!.once('close', () => resolve()));
  await page.getByRole('dialog').getByRole('button', { name: /^(Restart and install|Neu starten und installieren)$/ }).click();
  let exitTimer: ReturnType<typeof setTimeout>;
  try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { exitTimer = setTimeout(() => reject(new Error('Native installer did not quit the old process')), 120_000); })]); }
  finally { clearTimeout(exitTimer!); }
  console.log('PASS native installer quit the original process');
  const updated = await wait(async () => JSON.parse(await readFile(launch, 'utf8')), value => value.version === '0.0.2' && value.pid !== oldLaunch.pid);
  assert(updated.pid > 0);
  browser = await wait(async () => {
    const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  }, () => true);
  const restored = await wait(async () => browser!.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('http://127.0.0.1:'))!, value => !!value);
  await restored.getByRole('button', { name: 'Sample house', exact: true }).waitFor();
  await restored.locator('[data-studio-preview="ready"]').waitFor({ timeout: 60_000 });
  assert.equal(await restored.getByLabel(/^(Versions|Versionen)$/).inputValue(), checkpoint);
  assert.equal((await restored.evaluate(() => window.archDesktop!.getUpdateState())).currentVersion, '0.0.2');
  assert.deepEqual(await readFile(storeSource), originalSource);
  newOrigin = new URL(restored.url()).origin;
  await restored.screenshot({ path: join(root, 'evidence/desktop-updates/restarted.png'), scale: 'device' });
  await assert.rejects(fetch(oldOrigin));
  completed = true;
  console.log(JSON.stringify({ status: 'passed', syntheticVersions: ['0.0.1', '0.0.2'], realSignedDownload: true, nativeReplacementAndRelaunch: true, projectAndCheckpointPreserved: true, untrustedWindowRefused: true }));
} finally {
  await browser?.close().catch(() => {});
  await electron?.close().catch(() => {});
  try {
    const { pid } = JSON.parse(await readFile(launch, 'utf8'));
    const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
    if (command.includes(join(temporary, 'installed/Arch Studio.app/Contents/MacOS/Arch Studio'))) process.kill(pid, 'SIGTERM');
  } catch {}
  feed.closeAllConnections();
  await new Promise<void>(resolve => feed.close(() => resolve()));
  if (newOrigin) await wait(async () => { try { await fetch(newOrigin!); return false; } catch { return true; } }, value => value, 10_000);
  await rm(join(homedir(), 'Library/Caches', cacheName), { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
  if (!completed) console.error('Native update fixture did not complete; all owned app/store/feed resources were stopped.');
}
