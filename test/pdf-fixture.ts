// Small PDF files for PageFetch's PDF tests (board ab-v16.103): written here byte by byte, so no test needs a PDF from
// the web. Each page holds lines of text in the standard font Helvetica, or no text at all (a grey box, as a scan has no
// text). The file has a valid cross-reference table, a title in its document information, and, on request, a JavaScript
// open action (which no PageFetch step may run) or a Standard security handler that needs a password.

import { once } from "node:events";
import { createDeflate, deflateSync } from "node:zlib";

/** A PDF string literal: the backslash and the parentheses escaped. */
const lit = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** A page's lines of text, null for a page with no text, or a content stream of its own (its bytes and its /Filter). */
export type PdfPage = string[] | null | { filter: string; data: Buffer };

/**
 * A PDF with one page for each item: its lines of text, null for a page with no text, or its own content stream.
 * `script`: an open action of JavaScript; `locked`: an encryption dictionary whose user password is not empty.
 */
export function makePdf(pages: PdfPage[], o: { title?: string; script?: string; locked?: boolean } = {}): Buffer {
  const objs: string[] = [];
  const pageId = (i: number) => 6 + i * 2;
  objs[1] = `<< /Type /Catalog /Pages 2 0 R${o.script ? " /OpenAction 5 0 R" : ""} >>`;
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = `<< ${o.title === undefined ? "" : `/Title ${lit(o.title)} `}/Producer (agent-browser tests) >>`;
  objs[5] = o.script ? `<< /Type /Action /S /JavaScript /JS ${lit(o.script)} >>` : "<< >>";
  pages.forEach((lines, i) => {
    const own = lines !== null && !Array.isArray(lines) ? lines : null;
    const content = own ? own.data.toString("latin1") : lines === null
      ? "0.5 g 72 500 300 200 re f"
      : `BT /F1 12 Tf 16 TL 72 720 Td ${(lines as string[]).map((l) => `${lit(l)} Tj T*`).join(" ")} ET`;
    objs[pageId(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(i) + 1} 0 R >>`;
    objs[pageId(i) + 1] = `<< /Length ${Buffer.byteLength(content, "latin1")}${own ? ` /Filter ${own.filter}` : ""} >>\nstream\n${content}\nendstream`;
  });
  const enc = objs.length;
  if (o.locked) objs[enc] = `<< /Filter /Standard /V 1 /R 2 /O <${"a5".repeat(32)}> /U <${"5a".repeat(32)}> /P -4 >>`;
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 4 0 R${o.locked ? ` /Encrypt ${enc} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * A page content stream of `size` spaces, compressed twice (`/Filter [/FlateDecode /FlateDecode]`): some KB in the PDF
 * that pdf.js decodes to `size` bytes in one buffer (review B1 of board ab-v16.103). The spaces go through zlib in parts
 * of 1 MiB, so the test's own memory stays small.
 */
export async function nestedFlate(size: number): Promise<{ filter: string; data: Buffer }> {
  const z = createDeflate({ level: 1 });
  const out: Buffer[] = [];
  z.on("data", (b: Buffer) => out.push(b));
  const part = Buffer.alloc(1024 * 1024, 0x20);
  for (let n = 0; n < size; n += part.length) {
    if (!z.write(size - n >= part.length ? part : part.subarray(0, size - n))) await once(z, "drain");
  }
  z.end();
  await once(z, "end");
  return { filter: "[/FlateDecode /FlateDecode]", data: deflateSync(Buffer.concat(out), { level: 9 }) };
}
