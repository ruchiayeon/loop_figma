// e2e.test.mjs — end-to-end integration gate tying every layer together:
//   store model (frames + nesting + auto-layout + component/instance)
//   -> toSVG (headless renderer)
//   -> toCode (design -> JSX)  -> fromCode (JSX -> design)  [round-trip inverse]
//   -> resolveInstances (masters expanded with overrides)
//
// Snapshots design.json and restores it at the end so running the gate never
// destroys the demo composition.  Run:  node e2e.test.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createNode, setOverride, saveDesign, loadDesign, toSVG, resolveInstances,
} from "./mcp-server/store.js";
import { toCode } from "./bridge/to-code.mjs";
import { fromCode } from "./bridge/from-code.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(__dirname, "design.json");
const snapshot = existsSync(DESIGN) ? readFileSync(DESIGN, "utf8") : null;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  PASS ", name); } else { fail++; console.log("  FAIL ", name); } };
const count = (s, re) => (s.match(re) || []).length;

try {
  // ---- Build a full composition through the real store path ----
  saveDesign({ version: 1, document: { width: 800, height: 600, background: "#fff" }, nodes: [] });

  const card = createNode({ type: "frame", name: "Card", x: 40, y: 40, width: 400, height: 300, fill: "#ffffff", clipsContent: true });
  createNode({ parentId: card.id, type: "text", name: "Title", x: 20, y: 16, text: "Hello", fontSize: 24, color: "#111" });

  // Reusable component + two overridden instances inside an auto-layout row.
  const btn = createNode({ type: "component", name: "Btn", x: 500, y: 40, width: 120, height: 40, fill: "#4f46e5" });
  const label = createNode({ parentId: btn.id, type: "text", name: "lbl", x: 20, y: 10, text: "Btn", fontSize: 16, color: "#fff" });

  const row = createNode({ parentId: card.id, type: "frame", name: "Row", x: 20, y: 80, width: 360, height: 48,
    fill: "transparent", layout: { mode: "horizontal", gap: 20, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "start", justify: "start" } });
  const a = createNode({ parentId: row.id, type: "instance", name: "A", componentId: btn.id, x: 0, y: 0 });
  const b = createNode({ parentId: row.id, type: "instance", name: "B", componentId: btn.id, x: 0, y: 0 });
  setOverride(a.id, label.id, { text: "Save" });
  setOverride(b.id, label.id, { text: "Discard" });

  const doc = loadDesign();

  // ---- Auto-layout resolved into stored coords ----
  const rowNode = doc.nodes.find(n => n.name === "Card").children.find(n => n.name === "Row");
  ok("auto-layout placed 2nd instance at gap offset (x=140)", rowNode.children[1].x === 140);

  // ---- toSVG renders through instance resolution + overrides ----
  const svg = toSVG(doc);
  ok("svg renders overridden instance labels", /<text[^>]*>Save<\/text>/.test(svg) && /<text[^>]*>Discard<\/text>/.test(svg));
  ok("svg renders master label once (Btn master in place)", count(svg, />Btn</g) === 1);
  ok("svg has a clipPath for the clipping frame", /clip-/.test(svg));

  // ---- resolveInstances expands without mutating the authoring doc ----
  const before = JSON.stringify(doc);
  const rdoc = resolveInstances(doc);
  ok("resolveInstances did not mutate authoring doc", JSON.stringify(doc) === before);
  const flat = JSON.stringify(rdoc);
  ok("resolved doc contains both override texts", flat.includes("Save") && flat.includes("Discard"));

  // ---- Bridge round-trip is an inverse on this real composition ----
  const jsx = toCode(doc);
  ok("toCode emits a named React component function", /function\s+\w+\s*\(/.test(jsx));
  ok("toCode references the Btn component per instance (data-instance-of)", count(jsx, /data-instance-of/g) >= 2);
  const back = fromCode(jsx);
  // Normalization per the bridge contract: round px, and treat "no layout" the
  // same as layout {mode:'none'} (the bridge canonicalizes the two as equal).
  const canon = (d) => JSON.parse(JSON.stringify(d), (k, v) => v);
  const stripNoneLayout = (n) => {
    if (n.layout && n.layout.mode === "none" && Object.keys(n.layout).length === 1) delete n.layout;
    if (n.children) n.children.forEach(stripNoneLayout);
  };
  // Order-insensitive: sort object keys recursively and round numbers.
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") return Object.keys(v).sort().reduce((o, k) => (o[k] = stable(v[k]), o), {});
    return typeof v === "number" ? Math.round(v) : v;
  };
  const norm = (d) => {
    const c = canon(d); c.nodes.forEach(stripNoneLayout);
    return JSON.stringify(stable(c));
  };
  ok("fromCode(toCode(doc)) preserves node count", JSON.stringify(countNodes(back)) === JSON.stringify(countNodes(doc)));
  ok("round-trip is an inverse (normalized deep-equal)", norm(back) === norm(doc));

  function countNodes(d) {
    let n = 0; const walk = (ns) => ns.forEach(x => { n++; if (x.children) walk(x.children); });
    walk(d.nodes); return n;
  }
} finally {
  // restore the demo composition no matter what
  if (snapshot !== null) writeFileSync(DESIGN, snapshot);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
