// test.js — quality gate for the MCP server (zero dependencies).
// Spawns server.js as a real MCP stdio subprocess, performs the JSON-RPC
// handshake, then exercises every tool and asserts the document changes the
// way it should. Exits non-zero if any assertion fails.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  loadDesign, createNode, updateNode, deleteNode, findNode, moveNode, toSVG,
} from "./store.js";

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

  // ---- Phase 1: nesting tree unit tests (drive store.js directly) ----
  storeTests();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// Direct unit tests of the store data model + recursive renderer. These run
// after the MCP block and share the same pass/fail counters so a single
// `node mcp-server/test.js` run is the whole gate.
function storeTests() {
  console.log("\n-- store.js nesting tree --");

  // Fresh document so ids/order are predictable.
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);

  // 1. frame + child rect: child lives in frame.children, not doc.nodes.
  const frame = createNode({ type: "frame", x: 50, y: 60, width: 400, height: 300 });
  const childRect = createNode({ type: "rect", parentId: frame.id, x: 10, y: 20, width: 80, height: 40 });
  let doc = loadDesign();
  check("child rect not in doc.nodes", !doc.nodes.some((n) => n.id === childRect.id));
  const frameInDoc = doc.nodes.find((n) => n.id === frame.id);
  check("child rect lives in frame.children", frameInDoc.children.some((n) => n.id === childRect.id));
  check("frame defaults clipsContent true", frameInDoc.clipsContent === true);

  // 2. update + delete on a deeply nested node (>=2 levels): frame > group > rect.
  const group = createNode({ type: "group", parentId: frame.id, x: 5, y: 5 });
  const deepRect = createNode({ type: "rect", parentId: group.id, x: 1, y: 2, width: 30, height: 30 });
  const updated = updateNode(deepRect.id, { fill: "#abcabc", x: 7 });
  check("update reaches deeply nested node", updated.fill === "#abcabc" && updated.x === 7);
  doc = loadDesign();
  const found = findNode(deepRect.id, doc);
  check("findNode locates node at depth 2", found && found.node.x === 7 && found.parent.id === group.id);
  deleteNode(deepRect.id);
  doc = loadDesign();
  check("delete removes deeply nested node", !findNode(deepRect.id, doc));
  check("delete leaves ancestors intact", !!findNode(group.id, doc) && !!findNode(frame.id, doc));

  // 3. deleting a frame removes its whole subtree.
  const innerChild = createNode({ type: "rect", parentId: group.id, width: 10, height: 10 });
  deleteNode(frame.id);
  doc = loadDesign();
  check("deleting frame removes frame", !findNode(frame.id, doc));
  check("deleting frame removes child group (subtree)", !findNode(group.id, doc));
  check("deleting frame removes grandchild (subtree)", !findNode(innerChild.id, doc));

  // 4. moveNode reparents; moving into own descendant THROWS (cycle prevention).
  const fA = createNode({ type: "frame", x: 0, y: 0, width: 200, height: 200 });
  const fB = createNode({ type: "frame", parentId: fA.id, x: 10, y: 10, width: 100, height: 100 });
  const leaf = createNode({ type: "rect", x: 300, y: 300, width: 20, height: 20 });
  moveNode(leaf.id, fB.id);
  doc = loadDesign();
  check("moveNode reparents into fB", findNode(leaf.id, doc).parent.id === fB.id);
  check("moveNode removed leaf from top level", !doc.nodes.some((n) => n.id === leaf.id));
  let threw = false;
  try { moveNode(fA.id, fB.id); } catch { threw = true; }
  check("moveNode into own descendant throws (cycle)", threw);
  // sanity: moving back to top level works.
  moveNode(leaf.id, null);
  doc = loadDesign();
  check("moveNode to top level works", doc.nodes.some((n) => n.id === leaf.id));

  // 5. BACKWARD COMPAT: existing flat design.json shape still loads + renders.
  const flat = {
    version: 1,
    document: { width: 1200, height: 800, background: "#ffffff" },
    nodes: [
      { id: "flat1", type: "rect", name: "Rect 1", x: 400, y: 100, width: 200, height: 120,
        rotation: 0, opacity: 1, fill: "#00aaff", stroke: "#1e1b4b", strokeWidth: 0, zIndex: 0 },
      { id: "flat2", type: "text", name: "T", x: 100, y: 300, width: 220, height: 40,
        rotation: 0, opacity: 1, fill: "transparent", text: "Legacy", fontSize: 24, color: "#111", zIndex: 1 },
    ],
  };
  writeFileSync(DESIGN_PATH, JSON.stringify(flat, null, 2));
  const reloaded = loadDesign();
  check("flat design.json loads (no children needed)", reloaded.nodes.length === 2);
  const flatSvg = toSVG(reloaded);
  check("flat design renders <svg>", flatSvg.includes("<svg"));
  check("flat design renders rect + text content", flatSvg.includes("<rect") && flatSvg.includes("Legacy"));
  // Backward-compat invariant: top-level coords are placed via translate() so the
  // absolute coords from the old format still position the node at (400,100).
  check("flat top-level node positioned at its absolute coords",
    flatSvg.includes('translate(400,100)'));

  // 6. SNAPSHOT for a nested structure: assert nested <g translate> wrappers and
  //    that the child's position reflects parent+child offset (goes RED if flat).
  const snapDoc = {
    version: 1,
    document: { width: 500, height: 500, background: "#ffffff" },
    nodes: [
      { id: "F", type: "frame", x: 100, y: 100, width: 300, height: 300,
        rotation: 0, opacity: 1, fill: "#eeeeee", stroke: "#cccccc", strokeWidth: 0, clipsContent: true,
        children: [
          { id: "C", type: "rect", x: 30, y: 40, width: 50, height: 50,
            rotation: 0, opacity: 1, fill: "#ff0000", stroke: "#000", strokeWidth: 0 },
        ] },
    ],
  };
  const snap = toSVG(snapDoc);
  const frameT = 'translate(100,100)';
  const childT = 'translate(30,40)';
  check("snapshot: frame wrapper translate present", snap.includes(frameT));
  check("snapshot: child wrapper translate present (relative coords)", snap.includes(childT));
  // The child <g> must appear AFTER the frame <g> opens — proving nesting, not flat.
  check("snapshot: child nested inside frame group",
    snap.indexOf(childT) > snap.indexOf(frameT));
  // Frame must clip its content.
  check("snapshot: frame clips content", snap.includes('clip-F') && snap.includes('clip-path="url(#clip-F)"'));
  // Child rect draws at LOCAL origin (0,0), not absolute — confirms transform-based placement.
  check("snapshot: child rect drawn at local origin",
    snap.includes('<rect x="0" y="0" width="50" height="50"'));

  // 7. Z-ORDER: moveNode with an index must change RENDER order, not just the
  //    array. zIndex must be renumbered to match array position after a move.
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const za = createNode({ type: "rect", x: 0, y: 0, width: 10, height: 10 });
  const zb = createNode({ type: "rect", x: 1, y: 0, width: 10, height: 10 });
  const zc = createNode({ type: "rect", x: 2, y: 0, width: 10, height: 10 });
  check("zorder: initial zIndex 0,1,2", za.zIndex === 0 && zb.zIndex === 1 && zc.zIndex === 2);
  // Send `a` to the end: array becomes [b,c,a].
  moveNode(za.id, null, 2);
  doc = loadDesign();
  const zaNode = doc.nodes.find((n) => n.id === za.id);
  check("zorder: moved node renumbered to last zIndex", zaNode.zIndex === 2);
  check("zorder: array order is [b,c,a]",
    doc.nodes[0].id === zb.id && doc.nodes[1].id === zc.id && doc.nodes[2].id === za.id);
  const zSvg = toSVG(doc);
  // Render order must follow array order: b (x=1), then c (x=2), then a (x=0).
  check("zorder: render order follows array after move",
    zSvg.indexOf('translate(1,') < zSvg.indexOf('translate(2,') &&
    zSvg.indexOf('translate(2,') < zSvg.indexOf('translate(0,'));

  // 7b. Cross-list move renumbers the destination too: moving into a frame whose
  //     existing child has zIndex 0 must put the moved node at zIndex 1 and render LAST.
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const zf = createNode({ type: "frame", x: 0, y: 0, width: 300, height: 300, clipsContent: false });
  const zExisting = createNode({ type: "rect", parentId: zf.id, x: 5, y: 5, width: 10, height: 10 });
  const zMover = createNode({ type: "rect", x: 7, y: 7, width: 10, height: 10 });
  moveNode(zMover.id, zf.id); // appended → should get zIndex 1.
  doc = loadDesign();
  const zfNode = doc.nodes.find((n) => n.id === zf.id);
  const moverNode = zfNode.children.find((n) => n.id === zMover.id);
  const existNode = zfNode.children.find((n) => n.id === zExisting.id);
  check("zorder: reparented node gets next zIndex", moverNode.zIndex === 1 && existNode.zIndex === 0);
  const zSvg2 = toSVG(doc);
  check("zorder: reparented node renders after existing child",
    zSvg2.indexOf('translate(5,5)') < zSvg2.indexOf('translate(7,7)'));

  // 8. CONTAINER GUARD: a node cannot be parented under a non-container.
  //    Neither createNode nor moveNode may orphan a child under a rect.
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const gRect = createNode({ type: "rect", x: 0, y: 0, width: 100, height: 100 });
  let createThrew = false;
  try { createNode({ type: "rect", parentId: gRect.id, x: 1, y: 1 }); } catch { createThrew = true; }
  check("guard: createNode under a rect throws", createThrew);

  const gLeaf = createNode({ type: "rect", x: 50, y: 50, width: 20, height: 20 });
  let moveThrew = false;
  try { moveNode(gLeaf.id, gRect.id); } catch { moveThrew = true; }
  check("guard: moveNode under a rect throws", moveThrew);
  // The leaf must remain a live, RENDERED top-level node — never silently dropped.
  doc = loadDesign();
  check("guard: leaf still a top-level node after rejected move",
    doc.nodes.some((n) => n.id === gLeaf.id));
  check("guard: rect did not gain children",
    !Array.isArray(doc.nodes.find((n) => n.id === gRect.id).children) ||
    doc.nodes.find((n) => n.id === gRect.id).children.length === 0);
  const gSvg = toSVG(doc);
  check("guard: leaf still rendered (not orphaned/dropped)",
    gSvg.includes('translate(50,50)'));
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
