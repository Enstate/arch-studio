/**
 * Fills the viewer's asset library with the CC0 Poly Haven assets listed in manifest.json.
 *
 * Originals go to packages/viewer/.assets (gitignored, never served). From them it derives the
 * served library and writes index.json, which the runtime reads to resolve "@lib/" paths:
 *   textures → textures/<id>/<res>/{color,normal,orm}.webp at 512 px and up to the set's tier
 *              (about 1024 px per metre of real surface, 2048 at most); orm packs ambient
 *              occlusion in red and roughness in green, so one texture serves both maps
 *   HDRIs    → hdri/<id>.hdr (2K sky for the window view) and hdri/<id>-env.hdr (1K, sun clipped,
 *              for lighting and reflections), with the sun direction in index.json
 *   models   → models/<id>.glb (deduplicated, webp textures ≤ 1024 px, meshopt-compressed geometry),
 *              and thumbs/<id>.webp, Poly Haven's 256 px picture, which hand editing shows in its trays
 * It also copies plans/* into the served folder. Skips anything already there.
 *   bun run fetch-assets [--from <existing library dir>] [--out <dir>]
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, mkdtempSync, copyFileSync, readdirSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, textureCompress, getBounds, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { FloatType } from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { pieceCategory } from '../src/plan/categories.ts';

const pkg = resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' }, 'public-dir': { type: 'string' } } });
const served = resolve(args['public-dir'] ?? 'apps/studio/public/viewer');
const lib = args.out ? resolve(args.out) : join(served, 'library');
const cache = join(pkg, '.assets');
const from = args.from ? resolve(args.from) : null;
if (from && !existsSync(from)) throw new Error(`--from ${from} does not exist`);

const API = 'https://api.polyhaven.com';
/** Bump to rebuild every derived file after changing how they are made. */
const DERIVED = 2;
/** Texels per metre of real surface a texture tier aims for. */
const DENSITY = 1024;
const TIERS = [512, 1024, 2048];
const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8')) as {
  textures: Record<string, { res: string }>;
  hdris: Record<string, { res: string }>;
  models: Record<string, { res: string }>;
};
type TextureMeta = { id: string; name: string; res: string; size: [number, number]; maps: string[] };
type ModelMeta = { id: string; name: string; size: [number, number, number]; front?: number };
const credits: string[] = [];
let downloaded = 0;

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { 'User-Agent': 'arch viewer asset fetcher' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

async function download(url: string): Promise<Buffer> {
  if (!url.startsWith('https://dl.polyhaven.org/') && !url.startsWith('https://cdn.polyhaven.com/asset_img/')) throw new Error(`refusing URL outside Poly Haven's CDN: ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const b = Buffer.from(await r.arrayBuffer());
  downloaded += b.length;
  return b;
}

const readJSON = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;

type FileEntry = { url: string; size: number };
type Files = Record<string, Record<string, Record<string, FileEntry & { include?: Record<string, FileEntry> }>>>;

// ---------- originals (cache) ----------

// The served folder used to hold the originals; adopt them instead of downloading again.
if (!existsSync(cache) && existsSync(join(lib, 'index.json')) && !readJSON<{ version?: number }>(join(lib, 'index.json')).version) {
  mkdirSync(cache, { recursive: true });
  for (const d of ['textures', 'hdri', 'models']) if (existsSync(join(lib, d))) cpSync(join(lib, d), join(cache, d), { recursive: true });
  for (const d of ['textures', 'hdri', 'models']) rmSync(join(lib, d), { recursive: true, force: true });
  console.log(`moved the original assets to ${cache}`);
}

async function fetchTexture(id: string, res: string): Promise<TextureMeta> {
  const out = join(cache, 'textures', id);
  const metaFile = join(out, 'meta.json');
  const prev = existsSync(metaFile) ? readJSON<TextureMeta>(metaFile) : null;
  if (prev && prev.res === res && prev.maps.includes('ao')) return prev;
  const src = from && join(from, 'textures', id);
  if (src && existsSync(join(src, 'meta.json')) && readJSON<TextureMeta>(join(src, 'meta.json')).res === res) {
    const meta = readJSON<TextureMeta>(join(src, 'meta.json'));
    mkdirSync(out, { recursive: true });
    for (const m of meta.maps) copyFileSync(join(src, `${m}.webp`), join(out, `${m}.webp`));
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`✓ ${id} (copied)`);
    return meta;
  }
  mkdirSync(out, { recursive: true });
  const files = await getJSON<Files>(`${API}/files/${id}`);
  const info = await getJSON<{ dimensions?: [number, number]; name: string }>(`${API}/info/${id}`);
  const pick = (k: string) => files[k]?.[res]?.jpg ?? files[k]?.[res]?.png;
  const maps: Record<string, FileEntry | undefined> = { color: pick('Diffuse'), normal: pick('nor_gl'), rough: pick('Rough'), ao: pick('AO') };
  for (const [name, f] of Object.entries(maps)) {
    if (!f) continue;
    // Normal maps lose less shading detail at a higher quality setting.
    await sharp(await download(f.url)).webp({ quality: name === 'normal' ? 92 : 85 }).toFile(join(out, `${name}.webp`));
  }
  // Poly Haven gives the physical size in millimetres; textures repeat every `size` meters.
  const size: [number, number] = info.dimensions ? [Math.round(info.dimensions[0]) / 1000, Math.round(info.dimensions[1]) / 1000] : [2, 2];
  const meta: TextureMeta = { id, name: info.name, res, size, maps: Object.keys(maps).filter((k) => maps[k]) };
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  credits.push(`- ${info.name} (texture), https://polyhaven.com/a/${id}`);
  console.log(`✓ ${id}  ${size[0]}×${size[1]} m`);
  return meta;
}

async function fetchHdri(id: string, res: string) {
  const out = join(cache, 'hdri', `${id}.hdr`);
  if (existsSync(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  const src = from && join(from, 'hdri', `${id}.hdr`);
  if (src && existsSync(src)) {
    copyFileSync(src, out);
    console.log(`✓ ${id} (copied)`);
    return out;
  }
  const files = await getJSON<Files>(`${API}/files/${id}`);
  writeFileSync(out, await download(files.hdri[res].hdr.url));
  const info = await getJSON<{ name: string }>(`${API}/info/${id}`);
  credits.push(`- ${info.name} (HDRI), https://polyhaven.com/a/${id}`);
  console.log(`✓ ${id}`);
  return out;
}

async function fetchModel(id: string, res: string): Promise<ModelMeta> {
  const out = join(cache, 'models', `${id}.glb`);
  const metaFile = join(cache, 'models', `${id}.json`);
  if (existsSync(out) && existsSync(metaFile)) return readJSON<ModelMeta>(metaFile);
  mkdirSync(dirname(out), { recursive: true });
  const src = from && join(from, 'models', id);
  if (src && existsSync(`${src}.glb`) && existsSync(`${src}.json`)) {
    copyFileSync(`${src}.glb`, out);
    copyFileSync(`${src}.json`, metaFile);
    console.log(`✓ ${id} (copied)`);
    return readJSON<ModelMeta>(metaFile);
  }
  const files = await getJSON<Files>(`${API}/files/${id}`);
  const g = files.gltf[res].gltf;
  // Downloads go to a fresh temp folder and are only read as data by glTF-Transform.
  const tmp = mkdtempSync(join(tmpdir(), `ph-${id}-`));
  try {
    const main = join(tmp, `${id}.gltf`);
    writeFileSync(main, await download(g.url));
    for (const [rel, f] of Object.entries(g.include ?? {})) {
      const p = resolve(tmp, rel);
      if (!p.startsWith(tmp)) throw new Error(`bad include path ${rel}`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, await download(f.url));
    }
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.read(main);
    await doc.transform(dedup(), weld(), prune(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }));
    await io.write(out, doc);
    const b = getBounds(doc.getRoot().listScenes()[0]);
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => Math.round(v * 1000) / 1000) as ModelMeta['size'];
    const info = await getJSON<{ name: string }>(`${API}/info/${id}`);
    const meta: ModelMeta = { id, name: info.name, size };
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
    credits.push(`- ${info.name} (model), https://polyhaven.com/a/${id}`);
    console.log(`✓ ${id}  ${size.join(' × ')} m (x × y × z)`);
    return meta;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- served library (derived) ----------

const stampOf = (file: string) => (existsSync(file) ? readJSON<{ v: number }>(file).v : 0);

/** Writes the tiers of one texture set; returns the resolutions written. */
async function deriveTexture(meta: TextureMeta) {
  const src = join(cache, 'textures', meta.id);
  const out = join(lib, 'textures', meta.id);
  const srcSize = await sharp(join(src, `${meta.maps[0]}.webp`)).metadata();
  const want = 2 ** Math.round(Math.log2(Math.max(meta.size[0], meta.size[1]) * DENSITY));
  const top = Math.min(TIERS[TIERS.length - 1], Math.max(TIERS[0], want), srcSize.width ?? TIERS[0]);
  const tiers = TIERS.filter((r) => r <= top);
  const stamp = join(out, 'derived.json');
  if (stampOf(stamp) === DERIVED) return tiers;
  rmSync(out, { recursive: true, force: true });
  const aspect = (srcSize.height ?? 1) / (srcSize.width ?? 1);
  for (const r of tiers) {
    const dir = join(out, String(r));
    mkdirSync(dir, { recursive: true });
    const w = r, h = Math.round(r * aspect);
    const fit = (m: string) => sharp(join(src, `${m}.webp`)).resize(w, h, { fit: 'fill' });
    if (meta.maps.includes('color')) await fit('color').webp({ quality: 85 }).toFile(join(dir, 'color.webp'));
    if (meta.maps.includes('normal')) await fit('normal').webp({ quality: 92 }).toFile(join(dir, 'normal.webp'));
    if (meta.maps.includes('ao') || meta.maps.includes('rough')) {
      const grey = (m: string) => (meta.maps.includes(m) ? fit(m).greyscale().raw().toBuffer() : Promise.resolve(Buffer.alloc(w * h, 255)));
      const [ao, rough] = await Promise.all([grey('ao'), grey('rough')]);
      const orm = Buffer.alloc(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        orm[i * 3] = ao[i];
        orm[i * 3 + 1] = rough[i];
      }
      await sharp(orm, { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 90 }).toFile(join(dir, 'orm.webp'));
    }
  }
  writeFileSync(stamp, `${JSON.stringify({ v: DERIVED, tiers })}\n`);
  console.log(`✓ ${meta.id}  ${tiers.join(', ')} px`);
  return tiers;
}

/** Radiance .hdr with run-length encoded scanlines, from linear RGB floats. */
function encodeHDR(width: number, height: number, rgb: Float32Array) {
  const head = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const chunks: Buffer[] = [head];
  const line = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const v = Math.max(r, g, b);
      if (v < 1e-32) {
        line[x * 4] = line[x * 4 + 1] = line[x * 4 + 2] = line[x * 4 + 3] = 0;
        continue;
      }
      const e = Math.floor(Math.log2(v)) + 1;
      const s = 256 / 2 ** e;
      line[x * 4] = Math.min(255, r * s);
      line[x * 4 + 1] = Math.min(255, g * s);
      line[x * 4 + 2] = Math.min(255, b * s);
      line[x * 4 + 3] = e + 128;
    }
    const out: number[] = [2, 2, width >> 8, width & 255];
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let run = 1;
        while (x + run < width && run < 127 && line[(x + run) * 4 + c] === line[x * 4 + c]) run++;
        if (run >= 4) {
          out.push(128 + run, line[x * 4 + c]);
          x += run;
          continue;
        }
        // Literal bytes up to the next run of four or more.
        let n = 0;
        while (x + n < width && n < 128) {
          let r2 = 1;
          while (x + n + r2 < width && r2 < 4 && line[(x + n + r2) * 4 + c] === line[(x + n) * 4 + c]) r2++;
          if (r2 >= 4) break;
          n++;
        }
        out.push(n);
        for (let k = 0; k < n; k++) out.push(line[(x + k) * 4 + c]);
        x += n;
      }
    }
    chunks.push(Buffer.from(out));
  }
  return Buffer.concat(chunks);
}

/**
 * Sky for the window view at 2K, and a 1K lighting copy with the sun disc clipped and a touch of
 * camera white balance; the runtime prefilters the small one instead of crunching 4K on load.
 */
function deriveHdri(id: string, file: string) {
  const outBg = join(lib, 'hdri', `${id}.hdr`);
  const outEnv = join(lib, 'hdri', `${id}-env.hdr`);
  const stamp = join(lib, 'hdri', `${id}.json`);
  if (stampOf(stamp) === DERIVED && existsSync(outBg) && existsSync(outEnv)) return readJSON<{ sun: number[] }>(stamp).sun;
  const buf = readFileSync(file);
  const tex = new HDRLoader().setDataType(FloatType).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) as unknown as { width: number; height: number; data: Float32Array };
  const { width, height, data } = tex;
  // Brightest texel in the upper half, as direction: the sun. Inverse of three's equirect lookup.
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < height / 2; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (l > best) [best, bx, by] = [l, x, y];
    }
  const lon = (bx / width - 0.5) * Math.PI * 2, lat = (0.5 - by / height) * Math.PI;
  const sun = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)].map((v) => Math.round(v * 1e4) / 1e4);
  const shrink = (w: number, clip: number, wb: [number, number, number]) => {
    const k = width / w, h = height / k;
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < k; dy++)
          for (let dx = 0; dx < k; dx++) {
            const i = ((y * k + dy) * width + x * k + dx) * 4;
            const cr = data[i] * wb[0], cg = data[i + 1] * wb[1], cb = data[i + 2] * wb[2];
            const l = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
            const s = l > clip ? clip / l : 1;
            r += cr * s;
            g += cg * s;
            b += cb * s;
          }
        const o = (y * w + x) * 3;
        out[o] = r / (k * k);
        out[o + 1] = g / (k * k);
        out[o + 2] = b / (k * k);
      }
    return { w, h, out };
  };
  mkdirSync(join(lib, 'hdri'), { recursive: true });
  const bg = shrink(Math.min(width, 2048), Infinity, [1, 1, 1]);
  writeFileSync(outBg, encodeHDR(bg.w, bg.h, bg.out));
  const env = shrink(Math.min(width, 1024), 12, [1.04, 1.0, 0.9]);
  writeFileSync(outEnv, encodeHDR(env.w, env.h, env.out));
  writeFileSync(stamp, `${JSON.stringify({ v: DERIVED, sun })}\n`);
  console.log(`✓ ${id}  sky ${bg.w}×${bg.h}, lighting ${env.w}×${env.h}`);
  return sun;
}

async function deriveModel(id: string) {
  const out = join(lib, 'models', `${id}.glb`);
  const stamp = join(lib, 'models', `${id}.derived.json`);
  if (stampOf(stamp) === DERIVED && existsSync(out)) return;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(join(cache, 'models', `${id}.glb`));
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  mkdirSync(dirname(out), { recursive: true });
  await io.write(out, doc);
  writeFileSync(stamp, `${JSON.stringify({ v: DERIVED })}\n`);
  console.log(`✓ ${id}`);
}

/** A model's picture and what it is, for the trays: kept with the originals, copied into the library. */
async function modelPicture(id: string): Promise<{ name: string; category: string; thumbnail?: string }> {
  const metaFile = join(cache, 'thumbs', `${id}.json`);
  const picture = join(cache, 'thumbs', `${id}.webp`);
  let meta = existsSync(metaFile) ? readJSON<{ name: string; categories: string[] }>(metaFile) : null;
  if (!meta || !existsSync(picture)) {
    const info = await getJSON<{ name: string; categories?: string[]; thumbnail_url?: string }>(`${API}/info/${id}`);
    meta = { name: info.name, categories: info.categories ?? [] };
    mkdirSync(dirname(picture), { recursive: true });
    if (info.thumbnail_url) writeFileSync(picture, await sharp(await download(info.thumbnail_url)).resize(256, 256, { fit: 'inside' }).webp({ quality: 80 }).toBuffer());
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  }
  const served = join(lib, 'thumbs', `${id}.webp`);
  if (existsSync(picture)) {
    mkdirSync(dirname(served), { recursive: true });
    copyFileSync(picture, served);
  }
  return { name: meta.name, category: pieceCategory(meta.categories.join(' '), id), ...(existsSync(picture) && { thumbnail: `thumbs/${id}.webp` }) };
}

const index = {
  version: DERIVED,
  textures: {} as Record<string, { size: [number, number]; maps: string[]; res: number[] }>,
  models: {} as Record<string, { size: [number, number, number]; front: number; name?: string; category?: string; thumbnail?: string }>,
  hdris: {} as Record<string, { sun: number[] }>,
};
for (const [id, o] of Object.entries(manifest.textures)) {
  const m = await fetchTexture(id, o.res);
  const res = await deriveTexture(m);
  const maps = [m.maps.includes('color') && 'color', m.maps.includes('normal') && 'normal', (m.maps.includes('ao') || m.maps.includes('rough')) && 'orm'].filter(Boolean) as string[];
  index.textures[id] = { size: m.size, maps, res };
}
for (const [id, o] of Object.entries(manifest.hdris)) {
  const file = await fetchHdri(id, o.res);
  index.hdris[id] = { sun: deriveHdri(id, file) };
}
for (const [id, o] of Object.entries(manifest.models)) {
  const m = await fetchModel(id, o.res);
  await deriveModel(id);
  // glTF bounds are x, y (up), z; the library lists [width, depth, height] like plan pieces.
  index.models[id] = { size: [m.size[0], m.size[2], m.size[1]], front: m.front ?? 0, ...(await modelPicture(id)) };
}
writeFileSync(join(lib, 'index.json'), `${JSON.stringify(index)}\n`);

for (const dir of [cache, lib]) {
  if (from && existsSync(join(from, 'CREDITS.md')) && !existsSync(join(dir, 'CREDITS.md'))) copyFileSync(join(from, 'CREDITS.md'), join(dir, 'CREDITS.md'));
}
if (credits.length) {
  for (const dir of [cache, lib]) {
    const file = join(dir, 'CREDITS.md');
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '# Asset credits\n\nAll assets are CC0 from Poly Haven (https://polyhaven.com). No attribution is required; this list records where each file came from.\n\n';
    writeFileSync(file, `${prev}${credits.join('\n')}\n`);
  }
}

if (!args.out) {
  for (const name of readdirSync(join(pkg, 'plans'))) cpSync(join(pkg, 'plans', name), join(served, 'plans', name), { recursive: true });
}
console.log(`\nLibrary in ${lib} (originals in ${cache}). Downloaded ${(downloaded / 1e6).toFixed(1)} MB.`);
