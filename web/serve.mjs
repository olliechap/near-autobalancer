// Serves the site locally with no dependencies: node web/serve.mjs, then open http://127.0.0.1:5310/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const port = Number(process.env.PORT ?? 5310);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".md": "text/plain" };
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err, body) => {
      if (err) return res.writeHead(404).end("not found");
      res.writeHead(200, { "content-type": (types[path.extname(file)] ?? "application/octet-stream") + "; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`Ballast site on http://127.0.0.1:${port}/`));
