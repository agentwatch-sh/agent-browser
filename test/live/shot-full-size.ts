// Shared CLI check for the default headless harness and the agent-mode own harness.
// Each page is local, taller than three viewports, and changes height with its width.
// SHOT_BASELINE=1 reports repeats without failing, for comparison with an older revision.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pngPixels } from "../../src/record.ts";

export async function shotSite() {
  const rows = Array.from({ length: 64 }, (_, i) => `<div style="background:rgb(${i * 3},${240 - i * 2},${80 + i})">Row ${i}: ${"The page has a different colour and number on each row. ".repeat(3)}</div>`).join("");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Full page capture</title><style>html,body{margin:0}body{font:20px/32px sans-serif}div{box-sizing:border-box;min-height:64px;padding:0 20px}</style>${rows}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://a.localhost:${(server.address() as { port: number }).port}/`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Compare the 300-pixel band at y=40 with every later band at y=40+n*H, byte for byte. */
export function repeatedBands(png: Buffer, height: number) {
  const p = pngPixels(png), stride = p.width * p.channels, band = (y: number) => p.data.subarray(y * stride, (y + 300) * stride);
  const compared: number[] = [], repeated: number[] = [];
  for (let y = 40 + height; y + 300 <= p.height; y += height) {
    compared.push(y);
    if (band(40).equals(band(y))) repeated.push(y);
  }
  assert.ok(compared.length >= 2, "the page must contain at least two later bands");
  return { width: p.width, height: p.height, compared, repeated };
}

export async function shotFullSizeChecks(cli: (...args: string[]) => Promise<any>, run: string, base: string) {
  await cli("open", base, "--name", "tall");
  const results = [];
  try {
    for (const size of ["1440x900", "1279x812", "390x844"]) {
      const path = join(run, `full-${size}.png`);
      await cli("text", "tall");
      const result = await cli("shot", "tall", path, "--full", "--size", size);
      assert.equal(result.ok, true, JSON.stringify(result));
      const bands = repeatedBands(readFileSync(path), Number(size.split("x")[1]));
      results.push({ size, ...bands });
      console.log(JSON.stringify({ size, ...bands }));
      if (process.env.SHOT_BASELINE !== "1") assert.deepEqual(bands.repeated, [], `${size}: repeated first screen`);
    }
  } finally { await cli("close", "tall"); }
  return results;
}
