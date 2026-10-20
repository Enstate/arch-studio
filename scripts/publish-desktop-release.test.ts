import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { publish, releaseAssets, releaseIdentity } from './publish-desktop-release';
const identity = { tag: 'v1.2.3', version: '1.2.3', commit: 'a'.repeat(40), repository: 'Enstate/arch-studio' };
test('release identity rejects abbreviated commits and unsafe repository names', () => {
  assert.throws(() => releaseIdentity({ RELEASE_TAG: identity.tag, GITHUB_SHA: 'abc', GH_REPO: identity.repository }));
  assert.throws(() => releaseIdentity({ RELEASE_TAG: identity.tag, GITHUB_SHA: identity.commit, GH_REPO: '../bad' }));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arch-publish-test-'));
  const bytes = Buffer.from('synthetic artifact');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
    await mkdir(join(directory, 'source'));
    const archives = ['config', 'project', 'viewer', 'ui', 'viewer-ui', 'renderer', 'project-tools'].map((name) => ({ package: `@arch/${name}`, file: `arch-${name}-1.2.3.tgz`, sha256, bytes: bytes.length }));
    for (const archive of archives) await writeFile(join(directory, 'source', archive.file), bytes);
    await writeFile(join(directory, 'source', 'release.json'), JSON.stringify({ schemaVersion: 1, ...identity, archives }));
    await writeFile(join(directory, 'source', 'SHA256SUMS'), archives.map((a) => `${a.sha256}  ${a.file}\n`).join(''));
    const files = [];
    for (const arch of ['arm64', 'x64']) {
      await mkdir(join(directory, arch));
      await writeFile(join(directory, arch, 'latest-mac.yml'), 'fixture');
      const desktopFiles = [];
      for (const ext of ['dmg', 'zip', 'dmg.blockmap', 'zip.blockmap']) {
        const url = `Arch-Studio-1.2.3-${arch}.${ext}`;
        await writeFile(join(directory, arch, url), bytes);
        desktopFiles.push({ file: url, bytes: bytes.length, sha256 });
        if (!ext.endsWith('blockmap')) files.push({ url, size: bytes.length, sha512 });
      }
      await writeFile(join(directory, arch, `desktop-${arch}.json`), JSON.stringify({ schemaVersion: 1, commit: identity.commit, version: identity.version, arch, sourceClean: true, files: desktopFiles }));
    }
    await writeFile(join(directory, 'latest-mac.yml'), stringify({ version: identity.version, files }));
    return { directory, bytes, files };
}
test('validates desktop provenance and rejects mixed commits, dirty sources and tampered assets', async () => {
  const { directory, bytes, files } = await fixture();
  try {
    assert.equal((await releaseAssets(directory, identity)).length, 20);
    const provenancePath = join(directory, 'arm64', 'desktop-arm64.json');
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    for (const mismatch of [{ commit: 'b'.repeat(40) }, { sourceClean: false }, { repository: 'Other/repository' }, { version: '1.2.4' }, { arch: 'x64' }]) {
      await writeFile(provenancePath, JSON.stringify({ ...provenance, ...mismatch }));
      await assert.rejects(releaseAssets(directory, identity), /Desktop provenance does not match release identity/);
    }
    await writeFile(provenancePath, JSON.stringify(provenance));
    for (const extension of ['zip', 'dmg.blockmap']) {
      const artifactPath = join(directory, 'arm64', `Arch-Studio-1.2.3-arm64.${extension}`);
      await writeFile(artifactPath, 'tampered');
      await assert.rejects(releaseAssets(directory, identity), /Desktop integrity mismatch/);
      await writeFile(artifactPath, bytes);
    }
    files[0]!.sha512 = 'tampered';
    await writeFile(join(directory, 'latest-mac.yml'), stringify({ version: identity.version, files }));
    await assert.rejects(releaseAssets(directory, identity), /Updater integrity mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const environment = { RELEASE_TAG: identity.tag, GITHUB_SHA: identity.commit, GH_REPO: identity.repository };
type RemoteAsset = { id: number; name: string; size: number; digest: string; state: string };
function github(assets: Awaited<ReturnType<typeof releaseAssets>>) {
  const calls: { args: string[]; body?: unknown }[] = [];
  const uploaded = new Map<string, string>();
  const release = { id: 73, tag_name: identity.tag, target_commitish: identity.commit, draft: true };
  const remote: RemoteAsset[] = [];
  let failUpload = 0;
  let denyList = false;
  let changeIdentity = false;
  const endpoint = `repos/${identity.repository}/releases`;
  function execute(args: string[], input?: string): Buffer {
    const body = input === undefined ? undefined : JSON.parse(input);
    calls.push({ args, body });
    if (args[0] === 'release') {
      assert.deepEqual(args.slice(0, 3), ['release', 'upload', identity.tag]);
      assert.deepEqual(args.slice(4), ['--repo', identity.repository]);
      if (failUpload && uploaded.size === failUpload) throw new Error('Interrupted upload');
      const local = assets.find((asset) => asset.path === args[3]);
      assert.ok(local);
      assert.ok(!remote.some((asset) => asset.name === local.name), 'existing assets must never be overwritten');
      const uploadedHash = createHash('sha256').update(readFileSync(local.path)).digest('hex');
      assert.equal(uploadedHash, local.sha256);
      uploaded.set(local.name, uploadedHash);
      remote.push({ id: remote.length + 1, name: local.name, size: local.bytes, digest: `sha256:${local.sha256}`, state: 'uploaded' });
      return Buffer.from('');
    }
    assert.equal(args[0], 'api');
    if (args[1] === endpoint && args.includes('--paginate')) {
      if (denyList) throw new Error('HTTP 403 Forbidden');
      return Buffer.from(JSON.stringify([[{ ...release }]]));
    }
    if (args[1] === `${endpoint}/${release.id}/assets`) return Buffer.from(JSON.stringify([remote]));
    assert.equal(args[1], `${endpoint}/${release.id}`, 'mutations and identity reads must address the stable release ID');
    const method = args[args.indexOf('--method') + 1];
    if (method === 'GET') return Buffer.from(JSON.stringify({ ...release, ...(changeIdentity ? { target_commitish: 'b'.repeat(40) } : {}) }));
    assert.equal(method, 'PATCH');
    assert.deepEqual(body, { draft: false });
    assert.equal(remote.length, 20);
    for (const local of assets) assert.equal(remote.find((asset) => asset.name === local.name)?.digest, `sha256:${local.sha256}`);
    release.draft = false;
    return Buffer.from(JSON.stringify(release));
  }
  return { calls, uploaded, release, remote, execute, interruptAfter: (count: number) => { failUpload = count; }, forbid: () => { denyList = true; }, changeIdentity: () => { changeIdentity = true; } };
}

test('published releases, foreign drafts and forbidden listing stop without mutation', async () => {
  const { directory } = await fixture();
  try {
    const assets = await releaseAssets(directory, identity);
    for (const refusal of ['published', 'foreign', 'forbidden']) {
      const remote = github(assets);
      if (refusal === 'published') remote.release.draft = false;
      if (refusal === 'foreign') remote.release.target_commitish = 'b'.repeat(40);
      if (refusal === 'forbidden') remote.forbid();
      await assert.rejects(publish(directory, environment, remote.execute), refusal === 'forbidden' ? /HTTP 403/ : /published or has different provenance/);
      assert.equal(remote.calls.length, 1);
      assert.equal(remote.uploaded.size, 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('interrupted publication resumes only missing immutable bytes and publishes the verified set by ID', async () => {
  const { directory } = await fixture();
  try {
    const assets = await releaseAssets(directory, identity);
    const remote = github(assets);
    remote.interruptAfter(7);
    await assert.rejects(publish(directory, environment, remote.execute), /Interrupted upload/);
    assert.equal(remote.release.draft, true);
    assert.equal(remote.remote.length, 7);
    const retained = structuredClone(remote.remote);
    remote.interruptAfter(0);
    const resumed = remote.calls.length;
    await publish(directory, environment, remote.execute);
    assert.deepEqual(remote.remote.slice(0, 7), retained);
    assert.equal(remote.calls.slice(resumed).filter((call) => call.args[0] === 'release').length, 13);
    assert.deepEqual([...remote.uploaded], assets.map((asset) => [asset.name, asset.sha256]));
    assert.equal(remote.release.draft, false);
    const lastCalls = remote.calls.slice(-3);
    assert.deepEqual(lastCalls.map((call) => call.args[1]), [`repos/${identity.repository}/releases/73`, `repos/${identity.repository}/releases/73/assets`, `repos/${identity.repository}/releases/73`]);
    assert.deepEqual(lastCalls[2]?.body, { draft: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('remote hash mismatch preserves the draft and refuses uploads or publication', async () => {
  const { directory } = await fixture();
  try {
    const assets = await releaseAssets(directory, identity);
    const remote = github(assets);
    const local = assets[0]!;
    remote.remote.push({ id: 1, name: local.name, size: local.bytes, state: 'uploaded', digest: `sha256:${'0'.repeat(64)}` });
    await assert.rejects(publish(directory, environment, remote.execute), /Remote asset integrity mismatch/);
    assert.equal(remote.calls.length, 2);
    assert.equal(remote.remote.length, 1);
    assert.equal(remote.uploaded.size, 0);
    assert.equal(remote.release.draft, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('identity changes during upload prevent publication even with all twenty assets', async () => {
  const { directory } = await fixture();
  try {
    const remote = github(await releaseAssets(directory, identity));
    remote.changeIdentity();
    await assert.rejects(publish(directory, environment, remote.execute), /Release identity changed/);
    assert.equal(remote.remote.length, 20);
    assert.equal(remote.release.draft, true);
    assert.ok(remote.calls.every((call) => !call.args.includes('PATCH')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
