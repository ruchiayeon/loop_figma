// roundtrip.test.mjs — GATE for the invertible code<->design bridge.
//
// Asserts the ROUND-TRIP invariant on >=3 fixture designs:
//   normalize(fromCode(toCode(design)))  deepEquals  normalize(design)
// and that toCode() output carries the expected data-node markers.
//
// normalize() is INTENTIONALLY MINIMAL so the gate stays honest: it only
//   (1) rounds px-valued fields (x,y,width,height,rotation,fontSize,
//       strokeWidth,x2,y2) and clamps opacity to 3 decimals,
//   (2) default-fills the small set of fields toCode/fromCode treat as
//       defaulted (so an absent field === its canonical value), and
//   (3) applies the ONE contractually-mandated loss: children of a flex
//       (auto-layout) parent do not carry x/y in CSS, so their x/y are
//       canonicalized to 0 on BOTH sides.
// Everything else (name, zIndex, rotation, clipsContent, layout, x2/y2, src,
// transparent fills, stroke color at width 0) must GENUINELY round-trip via
// data-* attributes — it is NOT erased here. If toCode/fromCode lose any of
// those, this test goes RED.

import { strict as assert } from "node:assert";
import { toCode } from "./to-code.mjs";
import { fromCode } from "./from-code.mjs";

// ---- normalize -------------------------------------------------------------

const round = (n) => Math.round(Number(n) || 0);
const opac = (n) => {
  const v = Number(n);
  return Math.round((Number.isFinite(v) ? v : 1) * 1000) / 1000;
};

function isFlex(node) {
  return node && node.layout && node.layout.mode && node.layout.mode !== "none";
}

function normLayout(L) {
  if (!L || !L.mode || L.mode === "none") return { mode: "none" };
  const p = L.padding || {};
  return {
    mode: L.mode,
    gap: round(L.gap || 0),
    padding: {
      top: round(p.top || 0),
      right: round(p.right || 0),
      bottom: round(p.bottom || 0),
      left: round(p.left || 0),
    },
    align: L.align || "start",
    justify: L.justify || "start",
  };
}

function normNode(node, parentFlex) {
  const isContainer = node.type === "frame" || node.type === "group";
  const out = {
    id: node.id,
    type: node.type,
    name: node.name == null ? "" : String(node.name),
    // Contractual loss: flex children drop x/y -> canonical 0.
    x: parentFlex ? 0 : round(node.x),
    y: parentFlex ? 0 : round(node.y),
    width: round(node.width),
    height: round(node.height),
    rotation: round(node.rotation || 0),
    opacity: opac(node.opacity == null ? 1 : node.opacity),
    fill: node.fill == null ? "transparent" : String(node.fill),
    stroke: node.stroke == null ? "transparent" : String(node.stroke),
    strokeWidth: round(node.strokeWidth || 0),
    zIndex: round(node.zIndex || 0),
  };
  if (node.type === "text") {
    out.fontSize = round(node.fontSize == null ? 16 : node.fontSize);
    out.color = node.color == null ? "#000000" : String(node.color);
    out.text = node.text == null ? "" : String(node.text);
  }
  if (node.type === "image") {
    out.src = node.src == null ? "" : String(node.src);
  }
  if (node.type === "line") {
    out.x2 = round(node.x2);
    out.y2 = round(node.y2);
  }
  if (node.type === "frame") {
    out.clipsContent = node.clipsContent !== false;
  }
  if (isContainer) {
    out.layout = normLayout(node.layout);
    const childFlex = isFlex(node);
    out.children = (Array.isArray(node.children) ? node.children : []).map((c) =>
      normNode(c, childFlex)
    );
  }
  return out;
}

function normalize(design) {
  const doc = design.document || {};
  return {
    version: design.version == null ? 1 : design.version,
    document: {
      width: round(doc.width == null ? 1200 : doc.width),
      height: round(doc.height == null ? 800 : doc.height),
      background: doc.background == null ? "#ffffff" : String(doc.background),
    },
    nodes: (Array.isArray(design.nodes) ? design.nodes : []).map((n) => normNode(n, false)),
  };
}

// ---- fixtures --------------------------------------------------------------

// 1) flat doc with two rects
const flatTwoRects = {
  version: 1,
  document: { width: 800, height: 600, background: "#fafafa" },
  nodes: [
    {
      id: "r1", type: "rect", name: "Box A",
      x: 40, y: 50, width: 160, height: 100, rotation: 0, opacity: 1,
      fill: "#4f46e5", stroke: "#1e1b4b", strokeWidth: 2, zIndex: 0,
    },
    {
      id: "r2", type: "rect", name: "Box B",
      x: 300, y: 220, width: 120, height: 80, rotation: 15, opacity: 0.5,
      fill: "#ef4444", stroke: "#7f1d1d", strokeWidth: 0, zIndex: 1,
    },
  ],
};

// 2) nested frame with a text child (and a line, to exercise x2/y2)
const nestedFrame = {
  version: 1,
  document: { width: 1200, height: 800, background: "#ffffff" },
  nodes: [
    {
      id: "f1", type: "frame", name: "Card",
      x: 100, y: 120, width: 400, height: 300, rotation: 0, opacity: 1,
      fill: "#f3f4f6", stroke: "#d1d5db", strokeWidth: 1, zIndex: 0,
      clipsContent: true, layout: { mode: "none" },
      children: [
        {
          id: "t1", type: "text", name: "Title",
          x: 20, y: 24, width: 220, height: 40, rotation: 0, opacity: 1,
          fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 0,
          text: "Hello <Figma> & co", fontSize: 24, color: "#111827",
        },
        {
          id: "ln1", type: "line", name: "Rule",
          x: 20, y: 80, width: 0, height: 0, rotation: 0, opacity: 1,
          fill: "transparent", stroke: "#111827", strokeWidth: 2, zIndex: 1,
          x2: 220, y2: 80,
        },
      ],
    },
  ],
};

// 3) auto-layout (flex) frame with three children — exercises the x/y drop,
//    gap/padding/align/justify, group container, and an image leaf.
const autoLayout = {
  version: 1,
  document: { width: 1000, height: 700, background: "#0b1020" },
  nodes: [
    {
      id: "al1", type: "frame", name: "Toolbar",
      x: 60, y: 60, width: 600, height: 120, rotation: 0, opacity: 0.9,
      fill: "#1f2937", stroke: "#374151", strokeWidth: 0, zIndex: 0,
      clipsContent: false,
      layout: {
        mode: "horizontal", gap: 16,
        padding: { top: 12, right: 20, bottom: 12, left: 20 },
        align: "center", justify: "space-between",
      },
      children: [
        {
          id: "c1", type: "ellipse", name: "Dot",
          x: 999, y: 999, width: 48, height: 48, rotation: 0, opacity: 1,
          fill: "#10b981", stroke: "#064e3b", strokeWidth: 0, zIndex: 0,
        },
        {
          id: "c2", type: "image", name: "Logo",
          x: 999, y: 999, width: 80, height: 80, rotation: 0, opacity: 1,
          fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 1,
          src: "https://example.com/logo.png",
        },
        {
          id: "g1", type: "group", name: "Pair",
          x: 999, y: 999, width: 200, height: 80, rotation: 0, opacity: 1,
          fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 2,
          layout: { mode: "none" },
          children: [
            {
              id: "c3", type: "rect", name: "Inner",
              x: 4, y: 6, width: 60, height: 40, rotation: 0, opacity: 1,
              fill: "#f59e0b", stroke: "#000000", strokeWidth: 0, zIndex: 0,
            },
          ],
        },
      ],
    },
  ],
};

const fixtures = [
  ["flat two rects", flatTwoRects],
  ["nested frame + text + line", nestedFrame],
  ["auto-layout frame w/ 3 children", autoLayout],
];

// ---- run -------------------------------------------------------------------

let passed = 0;
const lines = [];

for (const [label, design] of fixtures) {
  const code = toCode(design);

  // Marker assertions: vocab must be present.
  assert.ok(/data-doc="root"/.test(code), `${label}: missing root marker`);
  assert.ok(/data-node-id="/.test(code), `${label}: missing data-node-id`);
  for (const n of flattenTypes(design.nodes)) {
    assert.ok(
      new RegExp(`data-node="${n}"`).test(code),
      `${label}: missing data-node="${n}" marker`
    );
  }
  lines.push(`  ok  ${label}: markers present`);
  passed++;

  // Round-trip invariant.
  const back = fromCode(code);
  const a = normalize(design);
  const b = normalize(back);
  assert.deepEqual(b, a, `${label}: round-trip not an inverse`);
  lines.push(`  ok  ${label}: normalize(fromCode(toCode(d))) deepEquals normalize(d)`);
  passed++;
}

// Negative control: prove the gate can go RED. Mutate decoded output and assert
// it no longer matches — confirms normalize isn't masking real losses.
{
  const code = toCode(nestedFrame);
  const back = fromCode(code);
  back.nodes[0].children[0].text = "tampered";
  assert.notDeepEqual(
    normalize(back),
    normalize(nestedFrame),
    "negative control: tampering should break equality"
  );
  lines.push("  ok  negative control: tampering breaks the round-trip (gate can go RED)");
  passed++;
}

function flattenTypes(nodes, acc = new Set()) {
  for (const n of nodes) {
    acc.add(n.type);
    if (Array.isArray(n.children)) flattenTypes(n.children, acc);
  }
  return acc;
}

console.log(lines.join("\n"));
console.log(`\n${passed} assertions passed — bridge round-trip is an inverse.`);
