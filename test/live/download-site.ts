// Local pages shared by the CLI download checks. No external hosts or services.
import { createServer } from "node:http";
export const CSV = "date,value\n2026-11-08,42\n";
export async function downloadSite() {
  const server = createServer((req, res) => {
    if (req.url === "/attachment.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="attachment.csv"' });
      res.end(CSV);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Local download check</title>
      <button id="attachment" onclick="location.href='/attachment.csv'">Export attachment</button>
      <button id="blob">Export blob</button>
      <script>document.getElementById('blob').onclick = () => {
        const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([${JSON.stringify(CSV)}],{type:'text/csv'}));
        a.download='blob.csv'; a.click();
      };</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://a.localhost:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
