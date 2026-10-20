import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { releaseAssets, releaseIdentity } from './publish-desktop-release';
const identity = { tag: 'v1.2.3', version: '1.2.3', commit: 'a'.repeat(40), repository: 'Enstate/arch-studio' };
test('release identity rejects abbreviated commits and unsafe repository names', () => {
  assert.throws(() => releaseIdentity({ RELEASE_TAG: identity.tag, GITHUB_SHA: 'abc', GH_REPO: identity.repository }));
  assert.throws(() => releaseIdentity({ RELEASE_TAG: identity.tag, GITHUB_SHA: identity.commit, GH_REPO: '../bad' }));
});
test('validates the complete immutable artifact set and catches changed updater bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arch-publish-test-'));
  const bytes = Buffer.from('synthetic artifact');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  try {
    await mkdir(join(directory, 'source'));
    const archives = ['config', 'project', 'viewer', 'ui', 'viewer-ui', 'renderer', 'project-tools'].map((name) => ({ package: `@arch/${name}`, file: `arch-${name}-1.2.3.tgz`, sha256, bytes: bytes.length }));
    for (const archive of archives) await writeFile(join(directory, 'source', archive.file), bytes);
    await writeFile(join(directory, 'source', 'release.json'), JSON.stringify({ schemaVersion: 1, ...identity, archives }));
    await writeFile(join(directory, 'source', 'SHA256SUMS'), archives.map((a) => `${a.sha256}  ${a.file}\n`).join(''));
    const files = [];
    for (const arch of ['arm64', 'x64']) {
      await mkdir(join(directory, arch));
      await writeFile(join(directory, arch, 'latest-mac.yml'), 'fixture');
      for (const ext of ['dmg', 'zip', 'dmg.blockmap', 'zip.blockmap']) {
        const url = `Arch-Studio-1.2.3-${arch}.${ext}`;
        await writeFile(join(directory, arch, url), bytes);
        if (!ext.endsWith('blockmap')) files.push({ url, size: bytes.length, sha512 });
      }
    }
    await writeFile(join(directory, 'latest-mac.yml'), stringify({ version: identity.version, files }));
    assert.equal((await releaseAssets(directory, identity)).length, 18);
    await writeFile(join(directory, 'arm64', 'Arch-Studio-1.2.3-arm64.zip'), 'tampered');
    await assert.rejects(releaseAssets(directory, identity), /Updater integrity mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
