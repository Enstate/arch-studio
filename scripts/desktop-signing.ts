import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Never inherit security's output: failures and partition-list output can contain
// key material. Do not put its arguments or output into an exception either.
const security = (operation: string, parameters: string[]) => {
  const result = spawnSync('/usr/bin/security', [operation, ...parameters], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`Signing keychain ${operation} failed (${result.status ?? 'signal'}).`);
  return result.stdout;
};

export async function withSigningKeychain(packageDesktop: () => Promise<void>) {
  const certificate = process.env.CSC_LINK;
  const certificatePassword = process.env.CSC_KEY_PASSWORD;
  // An explicitly prepared keychain remains supported for local operators.
  if (!certificate) {
    if (!process.env.CSC_KEYCHAIN) throw new Error('Release signing requires CSC_LINK and CSC_KEY_PASSWORD, or CSC_KEYCHAIN.');
    await packageDesktop();
    return;
  }
  if (certificatePassword === undefined) throw new Error('CSC_LINK requires CSC_KEY_PASSWORD, which may be empty for an unprotected P12.');
  const directory = await mkdtemp(join(tmpdir(), 'arch-signing-'));
  const keychain = join(directory, 'signing.keychain-db');
  const certificatePath = join(directory, 'certificate.p12');
  const keychainPassword = randomBytes(32).toString('hex');
  const previousKeychain = process.env.CSC_KEYCHAIN;
  let created = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.env.CSC_LINK = certificate;
    if (certificatePassword === undefined) delete process.env.CSC_KEY_PASSWORD;
    else process.env.CSC_KEY_PASSWORD = certificatePassword;
    if (previousKeychain === undefined) delete process.env.CSC_KEYCHAIN;
    else process.env.CSC_KEYCHAIN = previousKeychain;
    try {
      if (created) {
        try {
          const current = security('list-keychains', ['-d', 'user']);
          const entries = [...current.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
          if (entries.includes(keychain)) security('list-keychains', ['-d', 'user', '-s', ...entries.filter(entry => entry !== keychain)]);
        } finally {
          security('delete-keychain', [keychain]);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const interrupted = () => {
    try { cleanup(); } finally { process.exit(130); }
  };
  const terminated = () => {
    try { cleanup(); } finally { process.exit(143); }
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);
  try {
    const source = certificate.startsWith('file://') ? fileURLToPath(certificate) : resolve(certificate);
    const isFile = await access(source).then(() => true, () => false);
    if (isFile) {
      await copyFile(source, certificatePath);
      await chmod(certificatePath, 0o600);
    } else {
      const base64 = certificate.replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new Error('CSC_LINK must be a P12 file path or base64 P12.');
      await writeFile(certificatePath, Buffer.from(base64, 'base64'), { mode: 0o600 });
    }
    security('create-keychain', ['-p', keychainPassword, keychain]);
    created = true;
    security('set-keychain-settings', ['-lut', '21600', keychain]);
    security('unlock-keychain', ['-p', keychainPassword, keychain]);
    security('import', [certificatePath, '-k', keychain, '-P', certificatePassword, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
    security('set-key-partition-list', ['-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain]);
    const identities = security('find-identity', ['-v', '-p', 'codesigning', keychain]);
    if (!identities.includes('Developer ID Application:')) throw new Error('The P12 has no valid Developer ID Application signing identity.');
    await rm(certificatePath);
    // electron-builder accepts this keychain for both identity lookup and codesign.
    // Avoid its automatic CSC_LINK import and leave the user's search list alone.
    process.env.CSC_KEYCHAIN = keychain;
    delete process.env.CSC_LINK;
    delete process.env.CSC_KEY_PASSWORD;
    await packageDesktop();
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    cleanup();
  }
}
