import path from "node:path";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const text = { contentType: "text/plain; charset=utf-8", sandboxed: true };
// Inline previews only. Markup and data are always shown as plain text, never rendered.
const previews: Record<string, { contentType: string; sandboxed: boolean; matches?: (body: Buffer) => boolean }> = {
  // Chromium refuses to start its PDF viewer in a sandboxed document, so PDFs rely on the content-type gate instead.
  ".pdf": { contentType: "application/pdf", sandboxed: false, matches: body => body.subarray(0, 1024).includes("%PDF-") },
  ".png": { contentType: "image/png", sandboxed: true, matches: body => body.subarray(0, 8).equals(png) },
  ".jpg": { contentType: "image/jpeg", sandboxed: true, matches: body => body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff },
  ".jpeg": { contentType: "image/jpeg", sandboxed: true, matches: body => body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff },
  ".webp": { contentType: "image/webp", sandboxed: true, matches: body => body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP" },
  ".txt": text, ".md": text, ".json": text, ".svg": text,
};

/** Response headers for a checkpoint reference, or null when it cannot be previewed inline. */
export function referenceHeaders(relative: string, body: Buffer, contentType: string, origin: string, inline: boolean): Headers | null {
  const filename = `filename*=UTF-8''${encodeURIComponent(path.basename(relative)).replace(/'/g, "%27")}`;
  const headers = new Headers({ "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "Content-Length": String(body.length) });
  if (!inline) {
    headers.set("Content-Type", contentType); headers.set("Content-Disposition", `attachment; ${filename}`);
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
    return headers;
  }
  const preview = previews[path.extname(relative).toLowerCase()];
  if (!preview || (preview.matches && !preview.matches(body))) return null;
  headers.set("Content-Type", preview.contentType); headers.set("Content-Disposition", `inline; ${filename}`);
  headers.set("Content-Security-Policy", `${preview.sandboxed ? "sandbox; " : ""}default-src 'none'; frame-ancestors ${origin}`);
  return headers;
}
