// serve.js — tiny static file server (Node built-ins only, no install).
// Serves the canvas + design.json to ANY device on your network.
// Run:  node serve.js     (optionally:  node serve.js 3000  to change port)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8080;
const HOST = "0.0.0.0"; // listen on all interfaces so other IPs can reach it
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  // allow cross-device fetches without cache surprises
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/canvas/";
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, HOST, () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log(`\nMini-Figma is serving on port ${PORT}\n`);
  console.log(`  This computer:   http://localhost:${PORT}/canvas/`);
  ips.forEach((ip) => console.log(`  Other devices:   http://${ip}:${PORT}/canvas/`));
  if (!ips.length) console.log("  (no LAN IP found — check your network connection)");
  console.log(`\nOther devices must be on the SAME network. If they can't connect,`);
  console.log(`allow Node through Windows Firewall (a prompt may appear on first run).`);
  console.log(`Press Ctrl+C to stop.\n`);
});
