// The fake Chrome and the fixture site as a process, for the Python adapter's tests. It prints one
// JSON line, {"ws", "base", "control"}, and runs until its standard input closes. The control server
// (127.0.0.1) lets a test add a tab by hand, inject traffic, and read the CDP calls of a tab.

import { createServer } from "node:http";
import { FakeChrome } from "./fake-chrome.ts";
import { fixtureServer, site } from "./helpers.ts";

const fx = await fixtureServer();
const fake = await FakeChrome.start(site(fx.base));

const control = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://control");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reply = (status: number, value: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && url.pathname === "/calls") return reply(200, fake.callsFor(url.searchParams.get("target") ?? ""));
    if (req.method === "POST" && url.pathname === "/page") return reply(200, { targetId: fake.addPage(url.searchParams.get("url") ?? "about:blank").targetId });
    if (req.method === "POST" && url.pathname === "/traffic") {
      const t = JSON.parse(body);
      const page = fake.pages.get(t.target);
      if (!page) return reply(404, { error: "no such page" });
      fake.traffic(page, t);
      return reply(200, {});
    }
    reply(404, { error: "not found" });
  });
});
await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));

const shutdown = async () => {
  control.close();
  await fake.close();
  await fx.close();
  process.exit(0);
};
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
process.stdin.resume();
process.on("SIGTERM", () => void shutdown());

process.stdout.write(JSON.stringify({ ws: fake.ws, base: fx.base, control: `http://127.0.0.1:${(control.address() as { port: number }).port}` }) + "\n");
