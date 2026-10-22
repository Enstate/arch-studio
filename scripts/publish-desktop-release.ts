import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

type Asset = { id: number; name: string; size: number; digest?: string; state: string };
type Release = { id: number; tag_name: string; target_commitish: string; draft: boolean; assets: Asset[] };
type LocalAsset = { name: string; path: string; bytes: number; sha256: string };
const hash = (bytes: Buffer, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
export function releaseIdentity(env: NodeJS.ProcessEnv) {
  const tag = env.RELEASE_TAG ?? '';
  const commit = env.GITHUB_SHA ?? '';
  const repository = env.GH_REPO ?? '';
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('Invalid RELEASE_TAG');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('GITHUB_SHA must be a full commit SHA');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new Error('Invalid GH_REPO');
  return { tag, commit, repository, version: tag.slice(1) };
}
export async function releaseAssets(directory: string, identity: ReturnType<typeof releaseIdentity>): Promise<LocalAsset[]> {
  const assets: LocalAsset[] = [];
  async function asset(folder: string, name: string) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || assets.some((item) => item.name === name)) throw new Error(`Unsafe or duplicate asset: ${name}`);
    const path = resolve(directory, folder, name);
    if (!(await lstat(path)).isFile()) throw new Error(`Not a regular asset: ${name}`);
    const bytes = await readFile(path);
    assets.push({ name, path, bytes: bytes.length, sha256: hash(bytes) });
    return bytes;
  }
  const provenance = JSON.parse((await asset('source', 'release.json')).toString());
  if (provenance.schemaVersion !== 1 || provenance.repository !== identity.repository || provenance.tag !== identity.tag || provenance.commit !== identity.commit || provenance.version !== identity.version) throw new Error('Source provenance does not match release identity');
  const packages = ['config', 'project', 'viewer', 'ui', 'viewer-ui', 'renderer', 'project-tools'];
  if (!Array.isArray(provenance.archives) || provenance.archives.length !== packages.length) throw new Error('Incomplete source archive set');
  const checksums = (await asset('source', 'SHA256SUMS')).toString();
  const expectedChecksums: string[] = [];
  for (const name of packages) {
    const file = `arch-${name}-${identity.version}.tgz`;
    const entries = provenance.archives.filter((entry: { package: string }) => entry.package === `@arch/${name}`);
    if (entries.length !== 1 || entries[0].file !== file) throw new Error(`Missing source archive ${file}`);
    const bytes = await asset('source', file);
    if (entries[0].sha256 !== hash(bytes) || entries[0].bytes !== bytes.length) throw new Error(`Source integrity mismatch: ${file}`);
    expectedChecksums.push(`${hash(bytes)}  ${file}`);
  }
  if (checksums.trim().split('\n').sort().join('\n') !== expectedChecksums.sort().join('\n')) throw new Error('Invalid SHA256SUMS');
  if ((await readdir(join(directory, 'source'))).sort().join('\n') !== assets.map((item) => item.name).sort().join('\n')) throw new Error('Unexpected source assets');
  const desktopNames = new Set<string>();
  for (const arch of ['arm64', 'x64']) {
    const names = await readdir(join(directory, arch));
    const expected = [`Arch-Studio-${identity.version}-${arch}.dmg`, `Arch-Studio-${identity.version}-${arch}.dmg.blockmap`, `Arch-Studio-${identity.version}-${arch}.zip`, `Arch-Studio-${identity.version}-${arch}.zip.blockmap`];
    const provenanceName = `desktop-${arch}.json`;
    const desktopProvenance = JSON.parse((await asset(arch, provenanceName)).toString());
    if (desktopProvenance.schemaVersion !== 1 || desktopProvenance.commit !== identity.commit || desktopProvenance.version !== identity.version || desktopProvenance.arch !== arch || desktopProvenance.sourceClean !== true || (desktopProvenance.repository !== undefined && desktopProvenance.repository !== identity.repository)) throw new Error(`Desktop provenance does not match release identity: ${arch}`);
    if (!Array.isArray(desktopProvenance.files) || desktopProvenance.files.length !== expected.length) throw new Error(`Incomplete desktop provenance: ${arch}`);
    // electron-builder's configured artifactName is authoritative for all four files.
    if (names.filter((name) => name !== 'latest-mac.yml' && name !== provenanceName).sort().join('\n') !== expected.sort().join('\n')) throw new Error(`Incomplete or unexpected ${arch} desktop assets`);
    for (const name of expected) {
      const bytes = await asset(arch, name);
      const entries = desktopProvenance.files.filter((entry: { file: string }) => entry.file === name);
      if (entries.length !== 1 || entries[0].sha256 !== hash(bytes) || entries[0].bytes !== bytes.length) throw new Error(`Desktop integrity mismatch: ${name}`);
      desktopNames.add(name);
    }
  }
  const manifest = parse((await asset('.', 'latest-mac.yml')).toString());
  if (manifest.version !== identity.version || !Array.isArray(manifest.files)) throw new Error('Invalid latest-mac.yml version');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!desktopNames.has(file.url) || seen.has(file.url)) throw new Error('Unexpected or duplicate updater file');
    seen.add(file.url);
    const local = assets.find((item) => item.name === file.url)!;
    if (file.size !== local.bytes || file.sha512 !== hash(await readFile(local.path), 'sha512', 'base64')) throw new Error(`Updater integrity mismatch: ${file.url}`);
  }
  for (const name of desktopNames) if (!name.endsWith('.blockmap') && !seen.has(name)) throw new Error(`Missing updater file: ${name}`);
  // The unsigned Windows installer is built on a Windows runner and updates from latest.yml.
  const installer = `Arch-Studio-Setup-${identity.version}-windows-x64.exe`;
  const windowsFiles = [installer, `${installer}.blockmap`];
  const windowsProvenance = JSON.parse((await asset('windows-x64', 'desktop-windows-x64.json')).toString());
  if (windowsProvenance.schemaVersion !== 1 || windowsProvenance.commit !== identity.commit || windowsProvenance.version !== identity.version || windowsProvenance.platform !== 'win32' || windowsProvenance.arch !== 'x64' || windowsProvenance.sourceClean !== true) throw new Error('Desktop provenance does not match release identity: windows-x64');
  if (!Array.isArray(windowsProvenance.files) || windowsProvenance.files.length !== windowsFiles.length) throw new Error('Incomplete desktop provenance: windows-x64');
  if ((await readdir(join(directory, 'windows-x64'))).filter((name) => name !== 'desktop-windows-x64.json' && name !== 'latest.yml').sort().join('\n') !== [...windowsFiles].sort().join('\n')) throw new Error('Incomplete or unexpected windows-x64 desktop assets');
  for (const name of windowsFiles) {
    const bytes = await asset('windows-x64', name);
    const entries = windowsProvenance.files.filter((entry: { file: string }) => entry.file === name);
    if (entries.length !== 1 || entries[0].sha256 !== hash(bytes) || entries[0].bytes !== bytes.length) throw new Error(`Desktop integrity mismatch: ${name}`);
  }
  const windowsManifest = parse((await asset('windows-x64', 'latest.yml')).toString());
  if (windowsManifest.version !== identity.version || !Array.isArray(windowsManifest.files) || windowsManifest.files.length !== 1 || windowsManifest.files[0].url !== installer) throw new Error('Invalid latest.yml');
  const local = assets.find((item) => item.name === installer)!;
  if (windowsManifest.files[0].size !== local.bytes || windowsManifest.files[0].sha512 !== hash(await readFile(local.path), 'sha512', 'base64')) throw new Error(`Updater integrity mismatch: ${installer}`);
  return assets;
}
function gh(args: string[], input?: string): Buffer {
  const result = spawnSync('gh', args, { input, maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) {
    // Do not echo subprocess output, which may contain credentials or request data.
    throw new Error(`GitHub request failed (${result.status ?? 'spawn error'}); publication stopped`);
  }
  return result.stdout;
}
export async function publish(directory: string, env = process.env, executeGh = gh) {
  const identity = releaseIdentity(env);
  const assets = await releaseAssets(directory, identity);
  const endpoint = `repos/${identity.repository}/releases`;
  const api = (path: string, method = 'GET', body?: unknown) => JSON.parse(executeGh(['api', path, '--method', method, ...(body === undefined ? [] : ['--input', '-'])], body === undefined ? undefined : JSON.stringify(body))!.toString());
  const releases: Release[] = JSON.parse(executeGh(['api', endpoint, '--paginate', '--slurp'])!.toString()).flat();
  const matches = releases.filter((release) => release.tag_name === identity.tag);
  if (matches.length > 1) throw new Error('Multiple releases have this tag');
  let release = matches[0];
  if (release && (!release.draft || release.target_commitish !== identity.commit)) throw new Error('Existing release is published or has different provenance');
  release ??= api(endpoint, 'POST', { tag_name: identity.tag, target_commitish: identity.commit, draft: true, name: identity.tag, body: `Signed and notarized native macOS apps, an unsigned Windows installer and immutable public source packages from commit ${identity.commit}. Archive hashes and provenance are attached.` });
  const releaseId = release!.id;
  function remoteAssets(): Asset[] { return JSON.parse(executeGh(['api', `${endpoint}/${releaseId}/assets`, '--paginate', '--slurp'])!.toString()).flat(); }
  function verify(remote: Asset[]) {
    const names = new Set<string>();
    for (const item of remote) {
      const local = assets.find((candidate) => candidate.name === item.name);
      if (!local || names.has(item.name) || item.state !== 'uploaded' || item.size !== local.bytes) throw new Error(`Unexpected or incomplete remote asset: ${item.name}`);
      names.add(item.name);
      const digest = item.digest ?? `sha256:${hash(executeGh(['api', `repos/${identity.repository}/releases/assets/${item.id}`, '-H', 'Accept: application/octet-stream'])!)}`;
      if (digest !== `sha256:${local.sha256}`) throw new Error(`Remote asset integrity mismatch: ${item.name}`);
    }
    return names;
  }
  const present = verify(remoteAssets());
  for (const asset of assets) if (!present.has(asset.name)) executeGh(['release', 'upload', identity.tag, asset.path, '--repo', identity.repository]);
  const final = api(`${endpoint}/${releaseId}`) as Release;
  if (!final.draft || final.tag_name !== identity.tag || final.target_commitish !== identity.commit) throw new Error('Release identity changed during upload');
  if (verify(remoteAssets()).size !== assets.length) throw new Error('Remote asset set is incomplete');
  api(`${endpoint}/${releaseId}`, 'PATCH', { draft: false });
  console.log(`Published ${identity.tag} with ${assets.length} verified assets`);
}
if (import.meta.main) await publish(process.argv[2] ?? 'release');
