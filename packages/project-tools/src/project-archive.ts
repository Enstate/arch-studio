import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { Inflate, Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** One ZIP entry: a JSON document, a short text, or a content-addressed file streamed from disk. */
export type ArchiveEntry =
  | { name: string; json: unknown }
  | { name: string; text: string }
  | { name: string; file: string; sha256: string; size: number };

const chunkBytes = 1 << 20;
const ascii = (bytes: Uint8Array, start: number, text: string) =>
  Buffer.from(bytes.subarray(start, start + text.length)).toString("latin1") === text;
/** Formats that are already compressed. Deflating them again only costs time. */
function alreadyCompressed(head: Uint8Array): boolean {
  return (
    (head[0] === 0x89 && ascii(head, 1, "PNG")) ||
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) ||
    ascii(head, 0, "GIF8") ||
    ascii(head, 0, "%PDF-") ||
    ascii(head, 0, "glTF") ||
    ascii(head, 4, "ftyp") ||
    (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) ||
    ascii(head, 0, "PK\u0003\u0004") ||
    (head[0] === 0x1f && head[1] === 0x8b) ||
    ascii(head, 0, "(µ/ý") ||
    ascii(head, 0, "wOF2") ||
    ascii(head, 0, "KTX ")
  );
}

/**
 * Write a ZIP one entry at a time, so no file is ever held whole in memory. File entries
 * are hashed as they stream and must match their recorded sha256 and size.
 * Returns the archive size in bytes. The file is created exclusively with mode 0600.
 */
export async function writeArchive(file: string, entries: Iterable<ArchiveEntry>, mtime: Date): Promise<number> {
  const handle = await fs.open(file, "wx", 0o600);
  let bytes = 0;
  let failure: Error | null = null;
  const pending: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) failure ??= error;
    else pending.push(chunk);
  });
  // fflate emits synchronously inside push(), so each flush writes at most one input chunk's output.
  const flush = async () => {
    if (failure) throw failure;
    for (let chunk = pending.shift(); chunk; chunk = pending.shift()) {
      await handle.write(chunk);
      bytes += chunk.length;
    }
  };
  try {
    for (const entry of entries) {
      if ("json" in entry || "text" in entry) {
        const stream = new ZipDeflate(entry.name, { level: 6 });
        stream.mtime = mtime;
        zip.add(stream);
        stream.push(new TextEncoder().encode("json" in entry ? JSON.stringify(entry.json) : entry.text), true);
        await flush();
        continue;
      }
      const source = await fs.open(entry.file, "r");
      try {
        const hash = createHash("sha256");
        let size = 0;
        let stream: ZipDeflate | ZipPassThrough | null = null;
        for (;;) {
          const buffer = Buffer.allocUnsafe(chunkBytes);
          const { bytesRead } = await source.read(buffer, 0, chunkBytes, null);
          const chunk = buffer.subarray(0, bytesRead);
          if (!stream) {
            stream = alreadyCompressed(chunk) ? new ZipPassThrough(entry.name) : new ZipDeflate(entry.name, { level: 6 });
            stream.mtime = mtime;
            zip.add(stream);
          }
          if (!bytesRead) break;
          hash.update(chunk);
          size += bytesRead;
          stream.push(chunk, false);
          await flush();
        }
        if (size !== entry.size || hash.digest("hex") !== entry.sha256)
          throw new Error(`Blob integrity failure: ${entry.sha256}`);
        stream.push(new Uint8Array(0), true);
        await flush();
      } finally {
        await source.close();
      }
    }
    zip.end();
    await flush();
    await handle.close();
    return bytes;
  } catch (error) {
    zip.terminate();
    await handle.close().catch(() => {});
    await fs.rm(file, { force: true });
    throw error;
  }
}

/** Hard ceilings for an untrusted archive. Declared sizes are checked before any byte inflates. */
export type ArchiveLimits = { entries: number; entryBytes: number; totalBytes: number };
type CentralEntry = { name: string; nameBytes: Buffer; method: 0 | 8; compressedSize: number; size: number; offset: number };
export type ArchiveReader = {
  names: string[];
  size(name: string): number;
  /** Stream one entry's bytes. Output beyond its declared size, or short of it, fails. */
  read(name: string, onChunk: (chunk: Uint8Array) => Promise<void> | void): Promise<void>;
  close(): Promise<void>;
};

function safeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 512 &&
    !name.startsWith("/") &&
    !/[\\:]/.test(name) &&
    ![...name].some((character) => character.charCodeAt(0) < 0x20) &&
    name.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

/**
 * Open a ZIP from its central directory. Streaming unzip that scans local headers is not
 * used: it can mistake signature bytes inside stored data for entry boundaries.
 * Encrypted, ZIP64, multi-disk, unknown-method, unsafe-name and duplicate entries fail.
 */
export async function openArchive(file: string, limits: ArchiveLimits): Promise<ArchiveReader> {
  const handle = await fs.open(file, "r");
  try {
    const length = (await handle.stat()).size;
    const read = async (position: number, size: number) => {
      if (position < 0 || size < 0 || position + size > length) throw new Error("Archive is truncated");
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      if (bytesRead !== size) throw new Error("Archive is truncated");
      return buffer;
    };
    const tailSize = Math.min(length, 22 + 0xffff);
    const tail = await read(length - tailSize, tailSize);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--)
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    if (end < 0) throw new Error("Not a ZIP archive");
    const disk = tail.readUInt16LE(end + 4);
    const directoryDisk = tail.readUInt16LE(end + 6);
    const onDisk = tail.readUInt16LE(end + 8);
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) throw new Error("Multi-disk archives are not supported");
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
    if (count > limits.entries) throw new Error("Archive has too many entries");
    if (directoryOffset + directorySize !== length - tailSize + end) throw new Error("Archive directory is malformed");
    const directory = await read(directoryOffset, directorySize);
    const entries = new Map<string, CentralEntry>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0;
    let at = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error("Archive directory is malformed");
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const compressedSize = directory.readUInt32LE(at + 20);
      const size = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const offset = directory.readUInt32LE(at + 42);
      if (at + 46 + nameLength + extraLength + commentLength > directory.length) throw new Error("Archive directory is malformed");
      const nameBytes = Buffer.from(directory.subarray(at + 46, at + 46 + nameLength));
      at += 46 + nameLength + extraLength + commentLength;
      if (flags & 0x41) throw new Error("Encrypted archives are not supported");
      if (method !== 0 && method !== 8) throw new Error("Unsupported archive compression");
      if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
      if (method === 0 && compressedSize !== size) throw new Error("Archive entry sizes disagree");
      if (offset + 30 + nameLength + compressedSize > directoryOffset) throw new Error("Archive entry is out of bounds");
      const name = decoder.decode(nameBytes);
      if (!safeEntryName(name)) throw new Error(`Unsafe archive entry name: ${JSON.stringify(name.slice(0, 120))}`);
      if (entries.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
      if (size > limits.entryBytes) throw new Error(`Archive entry is too large: ${name}`);
      total += size;
      if (total > limits.totalBytes) throw new Error("Archive expands beyond the size limit");
      entries.set(name, { name, nameBytes, method, compressedSize, size, offset });
    }
    if (at !== directory.length) throw new Error("Archive directory is malformed");
    const entry = (name: string) => {
      const found = entries.get(name);
      if (!found) throw new Error(`Missing archive entry: ${name}`);
      return found;
    };
    return {
      names: [...entries.keys()],
      size: (name) => entry(name).size,
      async read(name, onChunk) {
        const found = entry(name);
        const local = await read(found.offset, 30);
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("Archive entry header is malformed");
        const nameLength = local.readUInt16LE(26);
        const extraLength = local.readUInt16LE(28);
        if (!(await read(found.offset + 30, nameLength)).equals(found.nameBytes)) throw new Error("Archive entry names disagree");
        let position = found.offset + 30 + nameLength + extraLength;
        const finish = position + found.compressedSize;
        if (finish > directoryOffset) throw new Error("Archive entry is out of bounds");
        let produced = 0;
        let ended = found.method === 0;
        const output: Uint8Array[] = [];
        const accept = (chunk: Uint8Array) => {
          produced += chunk.length;
          if (produced > found.size) throw new Error(`Archive entry expands beyond its size: ${name}`);
          output.push(chunk);
        };
        const inflate = found.method === 8 ? new Inflate((chunk, final) => { accept(chunk); if (final) ended = true; }) : null;
        // Small reads bound how much one inflate step can expand in memory.
        const step = 64 * 1024;
        do {
          const size = Math.min(step, finish - position);
          const chunk = size ? await read(position, size) : new Uint8Array(0);
          position += size;
          if (inflate) inflate.push(chunk, position === finish);
          else if (size) accept(chunk);
          for (let next = output.shift(); next; next = output.shift()) await onChunk(next);
        } while (position < finish);
        if (!ended || produced !== found.size) throw new Error(`Archive entry is incomplete: ${name}`);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
