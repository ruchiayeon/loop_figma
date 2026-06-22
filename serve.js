// serve.js — tiny static file server (Node built-ins only, no install).
// Serves the canvas + design.json to ANY device on your network.
// Run:  node serve.js     (optionally:  node serve.js 3000  to change port)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { createSyncHub, watchDesign } from "./realtime/sync-server.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8080;
const SYNC_PORT = PORT + 1; // canvas connectSync() defaults to this (8081 when PORT=8080)
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

// Realtime live-reload: mount the WebSocket hub and broadcast on design.json
// changes so every open canvas refetches automatically (no Load button needed).
// The canvas connects via connectSync({ port: SYNC_PORT }).
const hub = createSyncHub({ port: SYNC_PORT });
hub.ready.then(() => {
  console.log(`  Live sync:       ws://localhost:${hub.port}  (canvas auto-reloads on design.json change)`);
  const designPath = join(ROOT, "design.json");
  if (existsSync(designPath)) watchDesign(hub, designPath);
}).catch((e) => console.error("  (live sync unavailable:", e.message + ")"));
