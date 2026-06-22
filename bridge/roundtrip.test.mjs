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

// Deep-normalize an instance's overrides map: { masterChildId: { ...patch } }.
// Keys + nested values must survive verbatim (px-ish numbers rounded to match
// the data-overrides JSON round-trip, which JSON.stringify preserves exactly).
function normOverrides(ov) {
  if (!ov || typeof ov !== "object") return {};
  const out = {};
  for (const k of Object.keys(ov).sort()) {
    const patch = ov[k];
    if (patch && typeof patch === "object") {
      const p = {};
      for (const pk of Object.keys(patch).sort()) p[pk] = patch[pk];
      out[k] = p;
    } else {
      out[k] = patch;
    }
  }
  return out;
}

function normNode(node, parentFlex) {
  // component is frame-like (own box + children); instance is a leaf USE.
  const isContainer =
    node.type === "frame" || node.type === "group" || node.type === "component";
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
  if (node.type === "frame" || node.type === "component") {
    out.clipsContent = node.clipsContent !== false;
  }
  if (node.type === "instance") {
    out.componentId = node.componentId == null ? "" : String(node.componentId);
    out.overrides = normOverrides(node.overrides);
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

// 4) one component master + TWO instances; one instance carries an override on
//    a master child. Exercises: named-function emission, per-instance usage,
//    componentId recovery, and the overrides map round-trip.
const componentTwoInstances = {
  version: 1,
  document: { width: 900, height: 600, background: "#ffffff" },
  nodes: [
    {
      id: "btn", type: "component", name: "Button",
      x: 40, y: 40, width: 160, height: 48, rotation: 0, opacity: 1,
      fill: "#2563eb", stroke: "transparent", strokeWidth: 0, zIndex: 0,
      clipsContent: true, layout: { mode: "none" },
      children: [
        {
          id: "btn.label", type: "text", name: "Label",
          x: 16, y: 12, width: 128, height: 24, rotation: 0, opacity: 1,
          fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 0,
          text: "Click me", fontSize: 16, color: "#ffffff",
        },
      ],
    },
    {
      id: "inst1", type: "instance", name: "Primary",
      x: 300, y: 100, width: 160, height: 48, rotation: 0, opacity: 1,
      fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 1,
      componentId: "btn", overrides: {},
    },
    {
      id: "inst2", type: "instance", name: "Success",
      x: 300, y: 200, width: 160, height: 48, rotation: 0, opacity: 1,
      fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 2,
      componentId: "btn",
      overrides: { "btn.label": { text: "Buy now", fill: "#16a34a" } },
    },
  ],
};

// 5) a component master nested INSIDE a frame (proves the component's tree
//    position survives via the placement marker, not just top-level emission),
//    plus an instance of it.
const componentInFrame = {
  version: 1,
  document: { width: 1000, height: 700, background: "#0b1020" },
  nodes: [
    {
      id: "frm", type: "frame", name: "Library",
      x: 20, y: 20, width: 500, height: 400, rotation: 0, opacity: 1,
      fill: "#111827", stroke: "#374151", strokeWidth: 1, zIndex: 0,
      clipsContent: true, layout: { mode: "none" },
      children: [
        {
          id: "card", type: "component", name: "Card",
          x: 30, y: 30, width: 200, height: 140, rotation: 0, opacity: 1,
          fill: "#1f2937", stroke: "transparent", strokeWidth: 0, zIndex: 0,
          clipsContent: false, layout: { mode: "none" },
          children: [
            {
              id: "card.title", type: "text", name: "Title",
              x: 12, y: 12, width: 160, height: 28, rotation: 0, opacity: 1,
              fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 0,
              text: "Card", fontSize: 20, color: "#e5e7eb",
            },
          ],
        },
      ],
    },
    {
      id: "cardInst", type: "instance", name: "Card Use",
      x: 600, y: 80, width: 200, height: 140, rotation: 0, opacity: 1,
      fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 1,
      componentId: "card", overrides: { "card.title": { text: "Featured" } },
    },
  ],
};

// 6) BUG 1 repro: a component master `outer` whose children contain ANOTHER
//    component master `inner`. collectComponents is depth-first so toCode emits
//    `function Comp_outer` BEFORE `function Comp_inner`, yet outer's body
//    references inner via a placement marker. The fixpoint guard used to freeze
//    outer with EMPTY children; order-independent two-phase resolution must keep
//    inner (and its subtree) spliced inside outer.
const componentInComponent = {
  version: 1,
  document: { width: 1000, height: 700, background: "#ffffff" },
  nodes: [
    {
      id: "outer", type: "component", name: "Outer",
      x: 40, y: 40, width: 320, height: 240, rotation: 0, opacity: 1,
      fill: "#0ea5e9", stroke: "transparent", strokeWidth: 0, zIndex: 0,
      clipsContent: true, layout: { mode: "none" },
      children: [
        {
          id: "outer.pad", type: "rect", name: "Pad",
          x: 8, y: 8, width: 40, height: 40, rotation: 0, opacity: 1,
          fill: "#1e293b", stroke: "transparent", strokeWidth: 0, zIndex: 0,
        },
        {
          id: "inner", type: "component", name: "Inner",
          x: 60, y: 60, width: 200, height: 120, rotation: 0, opacity: 1,
          fill: "#22c55e", stroke: "transparent", strokeWidth: 0, zIndex: 1,
          clipsContent: false, layout: { mode: "none" },
          children: [
            {
              id: "inner.label", type: "text", name: "Label",
              x: 10, y: 10, width: 160, height: 24, rotation: 0, opacity: 1,
              fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 0,
              text: "Nested", fontSize: 16, color: "#052e16",
            },
          ],
        },
      ],
    },
    {
      id: "innerInst", type: "instance", name: "Inner Use",
      x: 600, y: 80, width: 200, height: 120, rotation: 0, opacity: 1,
      fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 1,
      componentId: "inner", overrides: { "inner.label": { text: "Used" } },
    },
  ],
};

// 7) BUG 2 repro: a component child whose text is the EXACT body-terminator
//    sentinel `);}` (and sibling text after it). esc() must escape ( ) { } so
//    the function-body extractor regex doesn't truncate at the literal `);}`.
const componentSentinelText = {
  version: 1,
  document: { width: 800, height: 600, background: "#ffffff" },
  nodes: [
    {
      id: "sent", type: "component", name: "Sentinel",
      x: 20, y: 20, width: 300, height: 160, rotation: 0, opacity: 1,
      fill: "#fde68a", stroke: "transparent", strokeWidth: 0, zIndex: 0,
      clipsContent: true, layout: { mode: "none" },
      children: [
        {
          id: "sent.t1", type: "text", name: "Trap",
          x: 10, y: 10, width: 200, height: 24, rotation: 0, opacity: 1,
          fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 0,
          text: ");}", fontSize: 16, color: "#000000",
        },
        {
          id: "sent.t2", type: "text", name: "After",
          x: 10, y: 40, width: 200, height: 24, rotation: 0, opacity: 1,
          fill: "transparent", stroke: "transparent", strokeWidth: 0, zIndex: 1,
          text: "still here ); } return ( {x} (y)", fontSize: 16, color: "#111111",
        },
      ],
    },
  ],
};

const fixtures = [
  ["flat two rects", flatTwoRects],
  ["nested frame + text + line", nestedFrame],
  ["auto-layout frame w/ 3 children", autoLayout],
  ["component + two instances + override", componentTwoInstances],
  ["component nested in frame + instance", componentInFrame],
  ["component nested in component (order-independent)", componentInComponent],
  ["component child text == body sentinel );}", componentSentinelText],
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

// ---- component/instance STRUCTURE assertions -------------------------------
// (a) one component declared ONCE as a named function, referenced PER instance.
{
  const code = toCode(componentTwoInstances);
  const declCount = (code.match(/function Comp_btn\(\)/g) || []).length;
  assert.equal(declCount, 1, "component function Comp_btn must be declared exactly once");
  // Two instances => two usages of <Comp_btn data-node="instance" .../>.
  const useCount = (code.match(/<Comp_btn data-node="instance"/g) || []).length;
  assert.equal(useCount, 2, "expected two <Comp_btn/> instance usages");
  // The override JSON must be present on the second instance.
  assert.ok(/data-instance-of="btn"/.test(code), "instance must record data-instance-of");
  assert.ok(/Buy now/.test(code), "override text must appear in emitted overrides JSON");
  lines.push("  ok  component declared once, referenced per instance, overrides carried");
  passed++;
}

// (b) nested-component placement marker present + single declaration.
{
  const code = toCode(componentInFrame);
  assert.equal(
    (code.match(/function Comp_card\(\)/g) || []).length,
    1,
    "nested component function Comp_card must be declared exactly once"
  );
  assert.ok(
    /<Comp_card data-node="component-placement"/.test(code),
    "nested component must leave a placement marker in the frame tree"
  );
  assert.ok(
    /<Comp_card data-node="instance"/.test(code),
    "instance of nested component must reference its function"
  );
  lines.push("  ok  nested component: one declaration + placement marker + instance usage");
  passed++;
}

// Negative control 2: tampering with an OVERRIDE must break round-trip equality
// (proves the extended normalize genuinely covers overrides, not a false green).
{
  const code = toCode(componentTwoInstances);
  const back = fromCode(code);
  const inst = back.nodes.find((n) => n.id === "inst2");
  inst.overrides["btn.label"].text = "tampered";
  assert.notDeepEqual(
    normalize(back),
    normalize(componentTwoInstances),
    "negative control: tampering an override should break equality"
  );
  lines.push("  ok  negative control: tampering an override breaks the round-trip");
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

// (c) BUG 1: nested component definition survives round-trip with its children.
{
  const code = toCode(componentInComponent);
  // Depth-first emission => Comp_outer declared before Comp_inner textually.
  const outerAt = code.indexOf("function Comp_outer()");
  const innerAt = code.indexOf("function Comp_inner()");
  assert.ok(outerAt !== -1 && innerAt !== -1, "both component fns declared");
  assert.ok(outerAt < innerAt, "outer is emitted textually before inner (DFS order)");

  const back = fromCode(code);
  const outer = back.nodes.find((n) => n.id === "outer");
  assert.ok(outer, "outer component recovered");
  // The historic bug: outer.children.length === 0. Must now be 2 (pad + inner).
  assert.equal(outer.children.length, 2, "outer must keep BOTH children (was 0 pre-fix)");
  const inner = outer.children.find((n) => n.id === "inner");
  assert.ok(inner && inner.type === "component", "nested inner component preserved");
  assert.equal(inner.children.length, 1, "inner's own subtree preserved");
  assert.equal(inner.children[0].text, "Nested", "inner's grandchild text preserved");
  lines.push("  ok  BUG1: nested component definition keeps children regardless of emit order");
  passed++;
}

// (d) BUG 2: a component child text equal to the `);}` body-terminator sentinel
//     (plus a trailing sibling) survives verbatim and does not truncate.
{
  const code = toCode(componentSentinelText);
  const back = fromCode(code);
  const sent = back.nodes.find((n) => n.id === "sent");
  assert.ok(sent, "sentinel component recovered");
  assert.equal(sent.children.length, 2, "both text children survive (no truncation)");
  assert.equal(sent.children[0].text, ");}", "the );} text must round-trip exactly");
  assert.equal(
    sent.children[1].text,
    "still here ); } return ( {x} (y)",
    "the trailing sibling text must round-trip exactly"
  );
  lines.push("  ok  BUG2: component child text == );} survives without truncating the body");
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
