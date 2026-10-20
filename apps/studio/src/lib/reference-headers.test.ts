import { expect, test } from "bun:test";
import { referenceHeaders } from "./reference-headers";

const origin = "http://127.0.0.1:4173";
const pdf = Buffer.from("%PDF-1.7\n%synthetic\n");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test("references download as sandboxed attachments unless inline is requested", () => {
  for (const [relative, body] of [["reference/plan.pdf", pdf], ["reference/plan.svg", svg]] as const) {
    const headers = referenceHeaders(relative, body, "application/octet-stream", origin, false)!;
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("content-disposition")).toStartWith("attachment; ");
    expect(headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  }
});

test("inline previews use a fixed type, frame only into the Studio origin and never render markup", () => {
  const document = referenceHeaders("reference/Plan.PDF", pdf, "application/octet-stream", origin, true)!;
  expect(document.get("content-type")).toBe("application/pdf");
  expect(document.get("content-disposition")).toBe("inline; filename*=UTF-8''Plan.PDF");
  expect(document.get("content-security-policy")).toBe(`default-src 'none'; frame-ancestors ${origin}`);
  const image = referenceHeaders("reference/plan.png", png, "application/octet-stream", origin, true)!;
  expect(image.get("content-type")).toBe("image/png");
  expect(image.get("content-security-policy")).toBe(`sandbox; default-src 'none'; frame-ancestors ${origin}`);
  for (const relative of ["reference/plan.svg", "reference/notes.md", "reference/data.json", "reference/notes.txt"]) {
    const headers = referenceHeaders(relative, svg, "application/octet-stream", origin, true)!;
    expect(headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(headers.get("content-security-policy")).toStartWith("sandbox; ");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  }
});

test("inline previews refuse unknown types and bytes that do not match the extension", () => {
  expect(referenceHeaders("reference/plan.html", svg, "application/octet-stream", origin, true)).toBeNull();
  expect(referenceHeaders("reference/plan.dwg", pdf, "application/octet-stream", origin, true)).toBeNull();
  expect(referenceHeaders("reference/plan.pdf", svg, "application/octet-stream", origin, true)).toBeNull();
  expect(referenceHeaders("reference/plan.png", pdf, "application/octet-stream", origin, true)).toBeNull();
  expect(referenceHeaders("reference/plan.jpg", svg, "application/octet-stream", origin, true)).toBeNull();
});
