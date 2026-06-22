// test.js — quality gate for the MCP server (zero dependencies).
// Spawns server.js as a real MCP stdio subprocess, performs the JSON-RPC
// handshake, then exercises every tool and asserts the document changes the
// way it should. Exits non-zero if any assertion fails.

import { spawn } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESIGN_PATH = resolve(__dirname, "..", "design.json");

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}`); }
}

function makeClient() {
  const child = spawn("node", [resolve(__dirname, "server.js")], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: res } = pending.get(msg.id);
        pending.delete(msg.id);
        res(msg);
      }
    }
  });
  function request(method, params) {
    const id = nextId++;
    return new Promise((res) => {
      pending.set(id, { resolve: res });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { child, request, notify };
}

const parse = (res) => JSON.parse(res.result.content[0].text);

async function main() {
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const { child, request, notify } = makeClient();

  const init = await request("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-runner", version: "1.0.0" },
  });
  check("initialize returns serverInfo", init.result.serverInfo.name === "mini-figma");
  check("initialize returns protocolVersion", typeof init.result.protocolVersion === "string");
  notify("notifications/initialized");

  const list = await request("tools/list", {});
  const names = list.result.tools.map((t) => t.name).sort();
  check("lists 5 tools", names.length === 5);
  check("expected tool names",
    JSON.stringify(names) === JSON.stringify(["create_node", "delete_node", "export_design", "get_design", "update_node"]));

  let design = parse(await request("tools/call", { name: "get_design", arguments: {} }));
  check("empty doc has 0 nodes", design.nodes.length === 0);
  check("doc has canvas size", design.document.width === 1200 && design.document.height === 800);

  const rect = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "rect", x: 100, y: 100, width: 200, height: 120, fill: "#ff0066" },
  }));
  check("create_node returns id", typeof rect.id === "string" && rect.id.length > 0);
  check("rect has correct fill", rect.fill === "#ff0066");
  check("rect zIndex 0", rect.zIndex === 0);

  const text = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "text", text: "Hello Figma", x: 100, y: 300, fontSize: 32 },
  }));
  check("text node stores text", text.text === "Hello Figma");
  check("text zIndex increments", text.zIndex === 1);

  design = JSON.parse(readFileSync(DESIGN_PATH, "utf8"));
  check("design.json persisted 2 nodes", design.nodes.length === 2);

  const updated = parse(await request("tools/call", {
    name: "update_node", arguments: { id: rect.id, x: 400, fill: "#00aaff" },
  }));
  check("update changed x", updated.x === 400);
  check("update changed fill", updated.fill === "#00aaff");
  check("update left height untouched", updated.height === 120);

  const bad = (await request("tools/call", { name: "create_node", arguments: { type: "triangle" } })).result;
  check("invalid node type errors", bad.isError === true);

  const badUpdate = (await request("tools/call", { name: "update_node", arguments: { id: "nope", x: 1 } })).result;
  check("update of missing node errors", badUpdate.isError === true);

  const svg = (await request("tools/call", { name: "export_design", arguments: { format: "svg" } })).result.content[0].text;
  check("svg export has <svg>", svg.includes("<svg"));
  check("svg export renders rect", svg.includes("<rect"));
  check("svg export renders text content", svg.includes("Hello Figma"));

  const del = parse(await request("tools/call", { name: "delete_node", arguments: { id: text.id } }));
  check("delete reports remaining", del.remaining === 1);
  design = parse(await request("tools/call", { name: "get_design", arguments: {} }));
  check("doc now has 1 node", design.nodes.length === 1);

  child.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
