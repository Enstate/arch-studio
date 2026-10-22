import { cp, mkdir, access, rm, writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { build, Platform, Arch, type Configuration } from 'electron-builder';
import { withSigningKeychain } from './desktop-signing';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1] ?? '';
const phase = args.includes('--phase') ? option('--phase') : 'all';
if (!['app', 'notarize', 'installer', 'all'].includes(phase)) throw new Error('Choose --phase app|notarize|installer|all.');
const release = args.includes('--release');
if (!release && !args.includes('--preview')) throw new Error('Choose --preview for local testing or --release for signed distribution.');
if (release && args.includes('--preview')) throw new Error('Choose exactly one packaging mode.');
const version = args.includes('--version') ? option('--version') : process.env.RELEASE_TAG?.replace(/^v/, '');
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error('Pass an explicit SemVer --version or RELEASE_TAG=v<version>.');
if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('Packaging requires macOS, Windows or Linux.');
const windows = process.platform === 'win32';
if (release && !['darwin', 'win32'].includes(process.platform)) throw new Error('Distribution requires a native macOS or Windows host.');
if (!['arm64', 'x64'].includes(process.arch) || (windows && process.arch !== 'x64')) throw new Error('Unsupported host architecture.');
// Windows installers are not Authenticode signed yet, so there is nothing to notarize.
if (windows && phase !== 'all' && phase !== 'app') throw new Error('Windows packaging supports only app or all phases.');
const executable = (name: string) => windows ? `${name}.exe` : name;
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
const appleId = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
const apiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
if (release && !windows && ['all', 'notarize'].includes(phase) && !profile && !appleId && !apiKey) throw new Error('Release requires APPLE_KEYCHAIN_PROFILE, or Apple ID/password/team, or App Store Connect API key credentials.');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const electronVersion = require('electron/package.json').version as string;
const output = resolve(root, 'artifacts', `arch-studio-${process.platform}-${process.arch}${release ? '' : '-preview'}`);
const stage = join(output, 'stage');
const resources = join(stage, 'resources');
const run = (command: string, parameters: string[]) => {
  const result = spawnSync(command, parameters, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'signal'}). No release is verified.`);
};
if (!release && !['app', 'all'].includes(phase)) throw new Error('Preview supports only app or all phases.');
const application = join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Arch Studio.app');
const stampPath = join(output, 'build.json');
const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const capture = (command: string, parameters: string[]) => {
  const result = spawnSync(command, parameters, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} validation failed.`);
  return result.stdout.trim();
};
const validateApplication = async () => {
  const stamp = JSON.parse(await readFile(stampPath, 'utf8'));
  const commit = capture('git', ['rev-parse', 'HEAD']);
  if (stamp.sourceClean !== true || capture('git', ['status', '--porcelain', '--untracked-files=normal']) !== '') throw new Error('Public desktop releases require clean source provenance. Run the app phase from a clean checkout.');
  if (stamp.commit !== commit || stamp.sourceChanges !== createHash('sha256').update(capture('git', ['diff', 'HEAD', '--', 'apps/desktop', 'apps/studio', 'packages/viewer', 'scripts/serve.mjs'])).digest('hex')) throw new Error('Source differs from the signed app provenance. Run the app phase from this checkout.');
  const staged = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  const plist = join(application, 'Contents/Info.plist');
  const appVersion = capture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  const executable = capture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]);
  const architecture = capture('lipo', ['-archs', join(application, 'Contents/MacOS', executable)]);
  const expectedArchitecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  if (stamp.version !== version || staged.version !== version || appVersion !== version || stamp.arch !== process.arch || architecture !== expectedArchitecture || stamp.platform !== process.platform || !stamp.signed) throw new Error('Existing app does not match the requested signed version and architecture. Run the app phase.');
  for (const [name, hash] of Object.entries(stamp.files as Record<string, string>)) {
    if (!['app.asar', 'bun', 'arch-server'].includes(name) || await digest(join(application, 'Contents/Resources', name)) !== hash) throw new Error('Existing app differs from its build provenance. Run the app phase.');
  }
  if (Object.keys(stamp.files).length !== 3) throw new Error('Incomplete app provenance. Run the app phase.');
  run('codesign', ['--verify', '--deep', '--strict', application]);
  return stamp;
};
if (['all', 'app'].includes(phase)) {
  if (release) {
    if (capture('git', ['status', '--porcelain', '--untracked-files=normal']) !== '') throw new Error('Public desktop releases require a clean checkout.');
    // Ignored dist output may belong to a different checkout revision.
    run(process.execPath, ['run', 'build:studio']);
  }
  await access(join(root, 'apps/studio/dist/server/server.js'));
  await access(join(root, 'apps/studio/dist/client'));
  await rm(output, { recursive: true, force: true });
  await mkdir(resources, { recursive: true });
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'arch-studio-desktop', productName: 'Arch Studio', version, main: 'main.cjs', description: 'Local architectural visualization Studio', author: 'Enstate', license: 'MIT' }));
  // Bundle the complete updater dependency graph, while Electron remains supplied by the runtime.
  run(process.execPath, ['build', './apps/desktop/main.cjs', '--target=node', '--format=cjs', '--external=electron', '--outfile', join(stage, 'main.cjs')]);
  await cp(join(root, 'apps/desktop/preload.cjs'), join(stage, 'preload.cjs'));
  await cp(join(root, 'apps/studio/dist/client'), join(resources, 'client'), { recursive: true });
  // Preserve the exact runtime hash inputs, including the original viewer manifest.
  await cp(join(root, 'packages/viewer/src'), join(resources, 'viewer/src'), { recursive: true });
  await cp(join(root, 'packages/viewer/package.json'), join(resources, 'viewer/package.json'));
  await cp(process.execPath, join(resources, executable('bun')));
  if (release) await writeFile(join(resources, 'app-update.yml'), 'provider: github\nowner: Enstate\nrepo: arch-studio\nchannel: latest\nupdaterCacheDirName: arch-studio-updater\n');
  run(process.execPath, ['build', '--compile', './scripts/serve.mjs', '--outfile', join(resources, executable('arch-server'))]);
}
const config: Configuration = {
  appId: 'co.enstate.arch.studio', productName: 'Arch Studio', electronVersion,
  icon: join(root, 'apps/desktop/icon.png'),
  directories: { app: stage, output }, asar: true,
  files: ['main.cjs', 'preload.cjs', 'package.json'],
  extraResources: [{ from: resources, to: '.' }],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these placeholders.
  artifactName: 'Arch-Studio-${version}-${arch}.${ext}',
  publish: release ? [{ provider: 'github', owner: 'Enstate', repo: 'arch-studio', releaseType: 'release' }] : null,
  forceCodeSigning: release && !windows && ['all', 'app'].includes(phase),
  // The disk image wraps the stapled app. Signing an unnotarized image itself
  // triggers a separate Gatekeeper failure; keep electron-builder's default.
  dmg: { sign: false },
  mac: {
    icon: join(root, 'apps/desktop/icon.icns'),
    identity: release ? (process.env.CSC_NAME || 'Matias Mora (3T885JB4UJ)') : null,
    hardenedRuntime: release, notarize: false,
    entitlements: join(root, 'apps/desktop/entitlements.mac.plist'),
    entitlementsInherit: join(root, 'apps/desktop/entitlements.mac.plist'),
    binaries: ['Contents/Resources/bun', 'Contents/Resources/arch-server'],
    category: 'public.app-category.graphics-design',
  },
  win: { icon: join(root, 'apps/desktop/icon.ico'), target: 'nsis' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these placeholders.
  nsis: { artifactName: 'Arch-Studio-Setup-${version}-windows-${arch}.${ext}', oneClick: true, perMachine: false },
};
// A per-user NSIS installer, built directly from the staged app. Its provenance names
// the commit and every published byte, like the macOS provenance.
const packageWindows = async () => {
  const sourceClean = capture('git', ['status', '--porcelain', '--untracked-files=normal']) === '';
  if (release && !sourceClean) throw new Error('Public desktop releases require a clean checkout.');
  const commit = capture('git', ['rev-parse', 'HEAD']);
  if (phase === 'app') {
    await build({ targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), config, publish: 'never' });
    console.log(`Local ${release ? 'release' : 'preview'} app only: ${output}`);
    return;
  }
  await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, publish: 'never' });
  if (!release) {
    console.log(`Local preview only: ${output}. This installer is not a release.`);
    return;
  }
  const provenancePath = join(output, 'desktop-windows-x64.json');
  const files = await Promise.all(['exe', 'exe.blockmap'].map(async extension => {
    const file = `Arch-Studio-Setup-${version}-windows-x64.${extension}`;
    const bytes = await readFile(join(output, file));
    return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }));
  await writeFile(provenancePath, JSON.stringify({ schemaVersion: 1, commit, version, platform: 'win32', arch: 'x64', sourceClean, files }, null, 2));
  console.log(`Release completed: ${output}`);
};
const packageDesktop = async () => {
  const platform = process.platform === 'darwin' ? Platform.MAC : Platform.LINUX;
  const arch = process.arch === 'arm64' ? Arch.arm64 : Arch.x64;
  if (['all', 'app'].includes(phase)) {
    const compileApp = async () => {
      const sourceClean = capture('git', ['status', '--porcelain', '--untracked-files=normal']) === '';
      if (release && !sourceClean) throw new Error('Public desktop releases require a clean checkout.');
      const commit = capture('git', ['rev-parse', 'HEAD']);
      await build({ targets: platform.createTarget(['dir'], arch), config, publish: 'never' });
      if (release) {
        const files = Object.fromEntries(await Promise.all(['app.asar', 'bun', 'arch-server'].map(async name => [name, await digest(join(application, 'Contents/Resources', name))])));
        await writeFile(stampPath, JSON.stringify({ version, arch: process.arch, platform: process.platform, signed: true, commit, sourceClean, sourceChanges: createHash('sha256').update(capture('git', ['diff', 'HEAD', '--', 'apps/desktop', 'apps/studio', 'packages/viewer', 'scripts/serve.mjs'])).digest('hex'), files }, null, 2), { mode: 0o600 });
      }
    };
    if (release) await withSigningKeychain(compileApp);
    else await compileApp();
  }
  if (release) {
    await validateApplication();
    if (['all', 'notarize'].includes(phase)) {
      const archive = join(output, 'notarization.zip');
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', application, archive]);
      const privateDirectory = await mkdtemp(join(tmpdir(), 'arch-notarize-'));
      try {
        let keyPath = process.env.APPLE_API_KEY!;
        if (apiKey && keyPath.includes('-----BEGIN')) {
          keyPath = join(privateDirectory, 'AuthKey.p8');
          await writeFile(keyPath, process.env.APPLE_API_KEY!, { mode: 0o600 });
        }
        const credentials = profile ? ['--keychain-profile', profile] : apiKey ? ['--key', keyPath, '--key-id', process.env.APPLE_API_KEY_ID!, '--issuer', process.env.APPLE_API_ISSUER!] : ['--apple-id', process.env.APPLE_ID!, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD!, '--team-id', process.env.APPLE_TEAM_ID!];
        run('xcrun', ['notarytool', 'submit', archive, ...credentials, '--wait']);
      } finally { await rm(privateDirectory, { recursive: true, force: true }); }
      run('xcrun', ['stapler', 'staple', application]);
      run('codesign', ['--verify', '--deep', '--strict', application]);
      run('spctl', ['--assess', '--type', 'execute', application]);
      await rm(archive);
    }
    if (['all', 'installer'].includes(phase)) {
      const provenancePath = join(output, `desktop-${process.arch}.json`);
      await rm(provenancePath, { force: true });
      run('xcrun', ['stapler', 'validate', application]);
      await build({ targets: Platform.MAC.createTarget(['dmg', 'zip'], arch), prepackaged: application, config, publish: 'never' });
      const stamp = await validateApplication();
      run('xcrun', ['stapler', 'validate', application]);
      const files = await Promise.all(['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap'].map(async extension => {
        const file = `Arch-Studio-${version}-${process.arch}.${extension}`;
        const bytes = await readFile(join(output, file));
        return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
      }));
      await writeFile(provenancePath, JSON.stringify({ schemaVersion: 1, commit: stamp.commit, version: stamp.version, arch: stamp.arch, sourceClean: stamp.sourceClean, files }, null, 2));
    }
    console.log(`Release phase ${phase} completed: ${output}`);
  } else {
    console.log(`Local preview only: ${output}. This app is not a signed or notarized distribution.`);
  }
};
await (windows ? packageWindows() : packageDesktop());
