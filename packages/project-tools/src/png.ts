import { unzlibSync, zlibSync } from "fflate";

/**
 * Shrinks a PNG so its longer side is at most `max` pixels, in plain JavaScript: the packaged
 * Studio server cannot load sharp. Reads 8-bit, non-interlaced grey, RGB and their alpha forms,
 * box-filters them down and writes an RGB or RGBA PNG. Null for anything else, and for images over
 * 16 megapixels, which would take hundreds of megabytes to decode.
 */
export function shrinkPng(png: Uint8Array, max: number): Uint8Array | null {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 33 || view.getUint32(0) !== 0x89504e47) return null;
  let width = 0, height = 0, type = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const length = view.getUint32(at);
    const kind = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      type = body[9]!;
      if (body[8] !== 8 || body[12] !== 0 || ![0, 2, 4, 6].includes(type)) return null;
    } else if (kind === "IDAT") data.push(body);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height || !data.length || width * height > 16_777_216) return null;
  if (Math.max(width, height) <= max) return png;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type as 0 | 2 | 4 | 6];
  const joined = concat(data);
  const raw = unzlibSync(joined);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  // Undo the per-row filters.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels]! : 0, b = up ? up[i]! : 0, c = up && i >= channels ? up[i - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      out[i] = (row[i]! + predictor) & 255;
    }
  }
  const scale = max / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const alpha = type === 4 || type === 6;
  const outChannels = alpha ? 4 : 3;
  const scanlines = new Uint8Array((w * outChannels + 1) * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      const sum = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = sy * stride + sx * channels;
          const grey = channels <= 2;
          sum[0]! += pixels[i]!;
          sum[1]! += pixels[grey ? i : i + 1]!;
          sum[2]! += pixels[grey ? i : i + 2]!;
          sum[3]! += alpha ? pixels[i + channels - 1]! : 255;
        }
      const n = (y1 - y0) * (x1 - x0);
      const o = y * (w * outChannels + 1) + 1 + x * outChannels;
      for (let k = 0; k < outChannels; k++) scanlines[o + k] = Math.round(sum[k]! / n);
    }
  }
  const chunk = (kind: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const at = new DataView(out.buffer);
    at.setUint32(0, body.length);
    out.set([...kind].map((c) => c.charCodeAt(0)), 4);
    out.set(body, 8);
    at.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, w);
  new DataView(header.buffer).setUint32(4, h);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlibSync(scanlines, { level: 9 })), chunk("IEND", new Uint8Array())];
  return concat(parts);
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
