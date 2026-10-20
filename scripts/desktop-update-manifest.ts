import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the downloaded desktop artifact directory.');
const manifests = await Promise.all(['arm64', 'x64'].map(async (arch) => {
  const manifest = parse(await readFile(join(directory, arch, 'latest-mac.yml'), 'utf8'));
  if (!manifest.version || !Array.isArray(manifest.files)) throw new Error(`Invalid ${arch} manifest`);
  for (const file of manifest.files) {
    if (typeof file.url !== 'string' || file.url.includes('/') || !file.url.includes(`-${arch}.`)) throw new Error(`Unsafe or wrong architecture artifact: ${file.url}`);
    const bytes = await readFile(join(directory, arch, file.url));
    if (createHash('sha512').update(bytes).digest('base64') !== file.sha512 || (file.size !== undefined && bytes.length !== file.size)) throw new Error(`Artifact integrity mismatch: ${file.url}`);
  }
  if (!manifest.files.some((file: { url: string }) => file.url.endsWith('.zip'))) throw new Error(`Missing ${arch} updater ZIP`);
  return manifest;
}));
if (manifests[0].version !== manifests[1].version) throw new Error('Architecture versions differ');
if (process.env.RELEASE_TAG && `v${manifests[0].version}` !== process.env.RELEASE_TAG) throw new Error('Desktop version does not match the source release tag');
// Keep x64 first for old clients; current electron-updater selects arm64 by its filename.
await writeFile(join(directory, 'latest-mac.yml'), stringify({ ...manifests[1], files: [...manifests[1].files, ...manifests[0].files] }));
