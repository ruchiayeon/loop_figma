// test.js — quality gate for the MCP server (zero dependencies).
// Spawns server.js as a real MCP stdio subprocess, performs the JSON-RPC
// handshake, then exercises every tool and asserts the document changes the
// way it should. Exits non-zero if any assertion fails.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  loadDesign, createNode, updateNode, deleteNode, findNode, moveNode, applyLayout, toSVG,
  setOverride, resolveInstances,
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
  check("lists 11 tools", names.length === 11);
  check("expected tool names",
    JSON.stringify(names) === JSON.stringify(["create_component", "create_instance", "create_node", "delete_node", "export_design", "get_design", "import_code", "move_node", "set_layout", "set_override", "update_node"]));

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

  // ---- NEW MCP TOOLS ----

  // image node: create + round-trip through SVG (<image href>).
  const img = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "image", x: 20, y: 30, width: 64, height: 48, src: "https://example.com/a.png" },
  }));
  check("create_node image stores src", img.type === "image" && img.src === "https://example.com/a.png");
  const imgSvg = (await request("tools/call", { name: "export_design", arguments: { format: "svg" } })).result.content[0].text;
  check("svg export renders <image href", imgSvg.includes('<image href="https://example.com/a.png"'));

  // set_layout on a frame with children resolves child x to padding.left.
  const lf = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "frame", x: 0, y: 0, width: 400, height: 200, clipsContent: false },
  }));
  const lc1 = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "rect", parentId: lf.id, x: 999, y: 999, width: 50, height: 50 },
  }));
  const lc2 = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "rect", parentId: lf.id, x: 999, y: 999, width: 50, height: 50 },
  }));
  const laidOut = parse(await request("tools/call", {
    name: "set_layout", arguments: { id: lf.id, mode: "horizontal", gap: 10, padding: { top: 5, right: 5, bottom: 5, left: 12 }, align: "start", justify: "start" },
  }));
  // set_layout returns the updated subtree with resolved child coords.
  check("set_layout returns subtree with resolved first child x = padding.left",
    laidOut.children[0].x === 12 && laidOut.children[0].y === 5);
  // second child = padding.left + width + gap = 12 + 50 + 10 = 72.
  check("set_layout resolves second child x (gap+width)", laidOut.children[1].x === 72);
  // The resolved coords are persisted to design.json.
  let lfDoc = JSON.parse(readFileSync(DESIGN_PATH, "utf8"));
  let lfPersist = lfDoc.nodes.find((n) => n.id === lf.id);
  check("auto-layout horizontal child x persisted to design.json", lfPersist.children[0].x === 12 && lfPersist.children[1].x === 72);

  // Adding ANOTHER child to the now-auto-layout frame re-resolves on create.
  const lc3 = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "rect", parentId: lf.id, x: 999, y: 999, width: 50, height: 50 },
  }));
  // third child = 12 + 2*(50+10) = 132.
  check("create child into auto-layout frame gets resolved x", lc3.x === 132 && lc3.y === 5);

  // move_node via MCP changes render order. Build two top-level rects at known x.
  const ma = parse(await request("tools/call", { name: "create_node", arguments: { type: "rect", x: 700, y: 0, width: 10, height: 10 } }));
  const mb = parse(await request("tools/call", { name: "create_node", arguments: { type: "rect", x: 800, y: 0, width: 10, height: 10 } }));
  const svgBefore = (await request("tools/call", { name: "export_design", arguments: { format: "svg" } })).result.content[0].text;
  check("move_node: before move ma renders before mb",
    svgBefore.indexOf('translate(700,0)') < svgBefore.indexOf('translate(800,0)'));
  parse(await request("tools/call", { name: "move_node", arguments: { id: ma.id, index: 99 } }));
  const svgAfter = (await request("tools/call", { name: "export_design", arguments: { format: "svg" } })).result.content[0].text;
  check("move_node via MCP changes render order (ma now after mb)",
    svgAfter.indexOf('translate(800,0)') < svgAfter.indexOf('translate(700,0)'));

  // export_design format=code returns JSX with data-node markers.
  const codeOut = (await request("tools/call", { name: "export_design", arguments: { format: "code" } })).result.content[0].text;
  check("export_design format=code returns JSX with data-node markers",
    codeOut.includes("function Design()") && codeOut.includes('data-node="rect"') && codeOut.includes('data-node="image"'));

  // import_code replaces the document.
  const replacementJsx =
    'function Design() {\n  return (\n' +
    '    <div data-doc="root" data-doc-version="1" data-doc-width="640" data-doc-height="480" data-doc-background="#222222" style={{ position: "relative", width: "640px", height: "480px", backgroundColor: "#222222" }}>\n' +
    '      <div data-node="rect" data-node-id="imp1" data-name="Imported" data-x="11" data-y="22" data-rotation="0" data-z="0" style={{ position: "absolute", left: "11px", top: "22px", width: "33px", height: "44px", opacity: 1, backgroundColor: "#abcdef", border: "0px solid transparent" }}></div>\n' +
    '    </div>\n  );\n}\n';
  const imported = parse(await request("tools/call", { name: "import_code", arguments: { jsx: replacementJsx } }));
  check("import_code replaces the document (new size + single node)",
    imported.document.width === 640 && imported.document.background === "#222222" &&
    imported.nodes.length === 1 && imported.nodes[0].id === "imp1" && imported.nodes[0].fill === "#abcdef");
  const afterImport = parse(await request("tools/call", { name: "get_design", arguments: {} }));
  check("import_code persisted: old nodes gone", afterImport.nodes.length === 1 && afterImport.nodes[0].id === "imp1");

  // ---- COMPONENTS / INSTANCES via MCP ----

  // Build a component master with a text child.
  const comp = parse(await request("tools/call", {
    name: "create_component", arguments: { x: 0, y: 0, width: 200, height: 80 },
  }));
  check("create_component returns a component node", comp.type === "component" && Array.isArray(comp.children));
  const label = parse(await request("tools/call", {
    name: "create_node", arguments: { type: "text", parentId: comp.id, x: 10, y: 10, text: "Click me" },
  }));
  check("component child text created", label.text === "Click me");

  // Two instances of the same master.
  const inst1 = parse(await request("tools/call", {
    name: "create_instance", arguments: { componentId: comp.id, x: 300, y: 50 },
  }));
  const inst2 = parse(await request("tools/call", {
    name: "create_instance", arguments: { componentId: comp.id, x: 300, y: 200 },
  }));
  check("create_instance returns instance with componentId", inst1.type === "instance" && inst1.componentId === comp.id);
  check("instance inherits master size by default", inst1.width === 200 && inst1.height === 80);

  // create_instance with bad componentId errors.
  const badInst = (await request("tools/call", { name: "create_instance", arguments: { componentId: "nope" } })).result;
  check("create_instance with missing component errors", badInst.isError === true);

  // SVG should contain the master text THREE times: once in the master itself
  // (it renders where it sits) + once per instance. At minimum >= 2 (per instance).
  const ciSvg = (await request("tools/call", { name: "export_design", arguments: { format: "svg" } })).result.content[0].text;
  const labelCount = ciSvg.split("Click me").length - 1;
  check("svg renders master text for each instance (>=2 occurrences)", labelCount >= 2);

  // Override changes ONLY that instance's text/fill.
  parse(await request("tools/call", {
    name: "set_override", arguments: { instanceId: inst1.id, masterChildId: label.id, props: { text: "Buy now", color: "#16a34a" } },
  }));
  const ovSvg = (await request("tools/call", { name: "export_design", arguments: { format: "svg" } })).result.content[0].text;
  check("override changes that instance's text", ovSvg.includes("Buy now"));
  check("override leaves the other instance text unchanged", (ovSvg.split("Click me").length - 1) >= 2);

  child.kill();

  // ---- Phase 1: nesting tree unit tests (drive store.js directly) ----
  storeTests();

  // ---- Phase 2: components / instances unit tests (drive store.js) ----
  componentTests();

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

  // 9. IMAGE node round-trips through create + toSVG (<image href).
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const image = createNode({ type: "image", x: 5, y: 6, width: 70, height: 90, src: "pic.png" });
  doc = loadDesign();
  const imageInDoc = findNode(image.id, doc).node;
  check("image: stored with src and type", imageInDoc.type === "image" && imageInDoc.src === "pic.png");
  const iSvg = toSVG(doc);
  check("image: renders <image href + sized box inside its <g transform",
    iSvg.includes('translate(5,6)') &&
    iSvg.includes('<image href="pic.png" x="0" y="0" width="70" height="90"/>'));

  // 10. AUTO-LAYOUT resolved into stored coords + idempotent applyLayout.
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const alf = createNode({
    type: "frame", x: 0, y: 0, width: 400, height: 200, clipsContent: false,
    layout: { mode: "horizontal", gap: 10, padding: { top: 4, right: 0, bottom: 0, left: 8 }, align: "start", justify: "start" },
  });
  createNode({ type: "rect", parentId: alf.id, x: 999, y: 999, width: 50, height: 30 });
  const alc2 = createNode({ type: "rect", parentId: alf.id, x: 999, y: 999, width: 50, height: 30 });
  doc = loadDesign();
  const alfNode = findNode(alf.id, doc).node;
  check("autolayout: stored child x resolved (first = padding.left)", alfNode.children[0].x === 8 && alfNode.children[0].y === 4);
  check("autolayout: stored second child x = left+width+gap", alfNode.children[1].x === 68);
  // createNode returned the RESOLVED node (not the input 999,999).
  check("autolayout: createNode returns resolved child coords", alc2.x === 68 && alc2.y === 4);
  // applyLayout is idempotent: running twice yields identical coords.
  applyLayout();
  const once = readFileSync(DESIGN_PATH, "utf8");
  applyLayout();
  const twice = readFileSync(DESIGN_PATH, "utf8");
  check("applyLayout is idempotent (two passes identical)", once === twice);

  // 11. AUTO-LAYOUT must NOT touch frames with no layout (explicit coords stay).
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const plainF = createNode({ type: "frame", x: 0, y: 0, width: 300, height: 300 });
  const plainChild = createNode({ type: "rect", parentId: plainF.id, x: 17, y: 23, width: 10, height: 10 });
  applyLayout();
  doc = loadDesign();
  const pc = findNode(plainChild.id, doc).node;
  check("autolayout: no-layout frame leaves child coords untouched", pc.x === 17 && pc.y === 23);

  // 12. DELETE must RE-RESOLVE auto-layout: removing a middle child of a
  //     horizontal auto-layout container must reflow survivors (no stale hole).
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const delF = createNode({
    type: "frame", x: 0, y: 0, width: 400, height: 200, clipsContent: false,
    layout: { mode: "horizontal", gap: 10, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "start", justify: "start" },
  });
  const dc1 = createNode({ type: "rect", parentId: delF.id, x: 999, y: 999, width: 50, height: 50 });
  const dc2 = createNode({ type: "rect", parentId: delF.id, x: 999, y: 999, width: 50, height: 50 });
  const dc3 = createNode({ type: "rect", parentId: delF.id, x: 999, y: 999, width: 50, height: 50 });
  // Resolved x with gap 10 + width 50: [0, 60, 120].
  doc = loadDesign();
  let delFNode = findNode(delF.id, doc).node;
  check("delete-reflow: initial resolved x = [0,60,120]",
    delFNode.children[0].x === 0 && delFNode.children[1].x === 60 && delFNode.children[2].x === 120);
  // Delete the MIDDLE child; survivors must reflow to [0,60], NOT keep [0,120].
  const delResult = deleteNode(dc2.id);
  doc = loadDesign();
  delFNode = findNode(delF.id, doc).node;
  check("delete-reflow: survivors reflow to [0,60] (not [0,120])",
    delFNode.children.length === 2 && delFNode.children[0].x === 0 && delFNode.children[1].x === 60);
  check("delete-reflow: surviving children are dc1 and dc3",
    delFNode.children[0].id === dc1.id && delFNode.children[1].id === dc3.id);
  // delete still reports the correct remaining count (frame + 2 survivors = 3).
  check("delete-reflow: remaining count correct after delete", delResult.remaining === 3);
}

// Direct unit tests of the component / instance model + instance resolution.
function componentTests() {
  console.log("\n-- store.js components / instances --");
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);

  // 1. A component master (frame-like) with a text child.
  const comp = createNode({ type: "component", x: 0, y: 0, width: 200, height: 60 });
  let doc = loadDesign();
  check("component is a container (has children[])", Array.isArray(findNode(comp.id, doc).node.children));
  const labelMaster = createNode({ type: "text", parentId: comp.id, x: 10, y: 10, text: "Original", color: "#111111" });
  check("text child lives in component.children", findNode(comp.id, loadDesign()).node.children.some((n) => n.id === labelMaster.id));

  // 2. Two instances of the same master at different positions.
  const i1 = createNode({ type: "instance", componentId: comp.id, x: 300, y: 0 });
  const i2 = createNode({ type: "instance", componentId: comp.id, x: 300, y: 100 });
  check("instance stores componentId + empty overrides", i1.componentId === comp.id && typeof i1.overrides === "object");
  check("instance defaults to master width/height", i1.width === 200 && i1.height === 60);

  // 3. createNode validation: missing/invalid componentId throws.
  let noCompThrew = false;
  try { createNode({ type: "instance", x: 0, y: 0 }); } catch { noCompThrew = true; }
  check("instance without componentId throws", noCompThrew);
  let badCompThrew = false;
  try { createNode({ type: "instance", componentId: "does-not-exist" }); } catch { badCompThrew = true; }
  check("instance with unknown componentId throws", badCompThrew);
  // componentId that points at a non-component throws too.
  const plainRect = createNode({ type: "rect", x: 0, y: 0, width: 10, height: 10 });
  let notCompThrew = false;
  try { createNode({ type: "instance", componentId: plainRect.id }); } catch { notCompThrew = true; }
  check("instance pointing at a non-component throws", notCompThrew);

  // 4. resolveInstances: each instance becomes a GROUP at its x/y with cloned children.
  doc = loadDesign();
  const rdoc = resolveInstances(doc);
  const r1 = rdoc.nodes.find((n) => n.id === i1.id);
  const r2 = rdoc.nodes.find((n) => n.id === i2.id);
  check("resolved instance is a group at the instance x/y", r1.type === "group" && r1.x === 300 && r1.y === 0);
  check("resolved instance contains the cloned master child", r1.children.length === 1 && r1.children[0].text === "Original");
  check("clone ids are instance-derived (instanceId:masterId)", r1.children[0].id === `${i1.id}:${labelMaster.id}`);
  // Authoring doc is NOT mutated by resolveInstances (still an instance, no children).
  check("resolveInstances does not mutate authoring doc", findNode(i1.id, loadDesign()).node.type === "instance");

  // 5. toSVG renders the master content for EACH instance (twice) + once for master.
  let svg = toSVG(loadDesign());
  check("toSVG renders master text twice (one per instance)", (svg.split("Original").length - 1) >= 2);
  // 6. Instance placed at x,y offsets its content by x,y (group transform).
  check("instance content offset by instance x,y", svg.includes("translate(300,0)") && svg.includes("translate(300,100)"));

  // 7. Override changes ONLY that instance's text/fill; the other is unchanged.
  setOverride(i1.id, labelMaster.id, { text: "Changed", color: "#16a34a" });
  svg = toSVG(loadDesign());
  check("override applies to its instance", svg.includes("Changed") && svg.includes('fill="#16a34a"'));
  // The non-overridden instance still shows the original text.
  check("override leaves the OTHER instance unchanged", svg.includes("Original"));
  // The original master child text is untouched in the authoring doc.
  check("override does not mutate the master child", findNode(labelMaster.id, loadDesign()).node.text === "Original");

  // 8. Updating the MASTER is reflected when re-resolving (live link).
  updateNode(labelMaster.id, { text: "MasterEdited" });
  svg = toSVG(loadDesign());
  // The non-overridden instance (i2) now shows the edited master text.
  check("editing master is reflected in non-overridden instance", svg.includes("MasterEdited"));
  // The overridden instance (i1) still shows its override, not the master edit.
  check("overridden instance keeps its override after master edit", svg.includes("Changed"));

  // 9. Deleting the component: re-resolving an instance of a now-missing master throws.
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const dComp = createNode({ type: "component", x: 0, y: 0, width: 100, height: 100 });
  createNode({ type: "text", parentId: dComp.id, x: 5, y: 5, text: "X" });
  const dInst = createNode({ type: "instance", componentId: dComp.id, x: 200, y: 0 });
  // Before delete: resolves fine.
  check("instance resolves before master delete", toSVG(loadDesign()).includes("X"));
  deleteNode(dComp.id);
  let resolveThrew = false;
  try { toSVG(loadDesign()); } catch { resolveThrew = true; }
  check("resolving an instance of a deleted component throws", resolveThrew);

  // 10. Nested-instance recursion throws (component contains an instance of itself).
  if (existsSync(DESIGN_PATH)) rmSync(DESIGN_PATH);
  const recComp = createNode({ type: "component", x: 0, y: 0, width: 100, height: 100 });
  // Put an instance of recComp INSIDE recComp -> a cycle.
  createNode({ type: "instance", parentId: recComp.id, componentId: recComp.id, x: 0, y: 0 });
  // A top-level instance of recComp must throw on resolution (cycle detected).
  createNode({ type: "instance", componentId: recComp.id, x: 200, y: 0 });
  let cycleThrew = false;
  try { resolveInstances(loadDesign()); } catch { cycleThrew = true; }
  check("nested-instance recursion throws (cycle guard)", cycleThrew);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
