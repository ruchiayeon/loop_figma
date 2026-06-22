// layout.test.mjs — exact-coordinate assertions for the auto-layout engine.
// Run: node mcp-server/layout.test.mjs
//
// Each fixture is built by hand and the expected child coordinates are computed
// by hand too, so any off-by-a-pixel error in layout.js turns these RED.

import { layout } from "./layout.js";

let passed = 0;
let failed = 0;

function eq(actual, expected, msg) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}\n        expected ${expected}, got ${actual}`);
  }
}

function section(name) {
  console.log(`\n# ${name}`);
}

// ---------------------------------------------------------------------------
// 1. Horizontal with gap + padding (align start, justify start).
// parent 400x200, padding {top:10,left:20}, gap 15.
// A(50x30): x=20, y=10.  B(60x40): x=20+50+15=85, y=10.
// ---------------------------------------------------------------------------
section("horizontal: gap + padding");
{
  const tree = {
    id: "p", type: "frame", x: 0, y: 0, width: 400, height: 200,
    layout: { mode: "horizontal", gap: 15, padding: { top: 10, right: 0, bottom: 0, left: 20 }, align: "start", justify: "start" },
    children: [
      { id: "a", type: "rect", x: 999, y: 999, width: 50, height: 30 },
      { id: "b", type: "rect", x: 999, y: 999, width: 60, height: 40 },
    ],
  };
  const out = layout(tree);
  const [a, b] = out.children;
  eq(a.x, 20, "A.x"); eq(a.y, 10, "A.y");
  eq(b.x, 85, "B.x"); eq(b.y, 10, "B.y");
  // purity: input untouched
  eq(tree.children[0].x, 999, "input not mutated (A.x)");
}

// ---------------------------------------------------------------------------
// 2. Vertical with align: center.
// parent 200x400, no padding, gap 10, align center.
// A(40x50): x=(200-40)/2=80, y=0.  B(80x30): x=(200-80)/2=60, y=0+50+10=60.
// ---------------------------------------------------------------------------
section("vertical: align center");
{
  const tree = {
    id: "p", type: "frame", x: 0, y: 0, width: 200, height: 400,
    layout: { mode: "vertical", gap: 10, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "center", justify: "start" },
    children: [
      { id: "a", type: "rect", x: 0, y: 0, width: 40, height: 50 },
      { id: "b", type: "rect", x: 0, y: 0, width: 80, height: 30 },
    ],
  };
  const out = layout(tree);
  const [a, b] = out.children;
  eq(a.x, 80, "A.x"); eq(a.y, 0, "A.y");
  eq(b.x, 60, "B.x"); eq(b.y, 60, "B.y");
}

// ---------------------------------------------------------------------------
// 3. space-between across 3 children (horizontal).
// parent 300x100, no padding, justify space-between, align start.
// 3 children w=40. free=300-120=180, gap=90.
// c0.x=0, c1.x=130, c2.x=260. all y=0.
// ---------------------------------------------------------------------------
section("horizontal: space-between, 3 children");
{
  const tree = {
    id: "p", type: "frame", x: 0, y: 0, width: 300, height: 100,
    layout: { mode: "horizontal", gap: 5, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "start", justify: "space-between" },
    children: [
      { id: "c0", type: "rect", x: 0, y: 0, width: 40, height: 20 },
      { id: "c1", type: "rect", x: 0, y: 0, width: 40, height: 20 },
      { id: "c2", type: "rect", x: 0, y: 0, width: 40, height: 20 },
    ],
  };
  const out = layout(tree);
  const [c0, c1, c2] = out.children;
  eq(c0.x, 0, "c0.x");   eq(c0.y, 0, "c0.y");
  eq(c1.x, 130, "c1.x"); eq(c1.y, 0, "c1.y");
  eq(c2.x, 260, "c2.x"); eq(c2.y, 0, "c2.y");
  // space-between ignores the configured gap entirely.
}

// ---------------------------------------------------------------------------
// 4. Nested auto-layout frame (inner-first resolution).
// Outer: vertical, 200x300, no padding, gap 0, align start.
//   child[0] = inner frame (100x50) horizontal, gap 10, align start, two rects 20x20.
//     inner r0.x=0,y=0 ; r1.x=0+20+10=30,y=0.
//   child[1] = rect 40x40.
// Outer places child[0] at x=0,y=0 ; child[1] at x=0, y=0+50+0=50.
// ---------------------------------------------------------------------------
section("nested auto-layout (inner-first)");
{
  const tree = {
    id: "outer", type: "frame", x: 0, y: 0, width: 200, height: 300,
    layout: { mode: "vertical", gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "start", justify: "start" },
    children: [
      {
        id: "inner", type: "frame", x: 999, y: 999, width: 100, height: 50,
        layout: { mode: "horizontal", gap: 10, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "start", justify: "start" },
        children: [
          { id: "r0", type: "rect", x: 999, y: 999, width: 20, height: 20 },
          { id: "r1", type: "rect", x: 999, y: 999, width: 20, height: 20 },
        ],
      },
      { id: "tail", type: "rect", x: 999, y: 999, width: 40, height: 40 },
    ],
  };
  const out = layout(tree);
  const inner = out.children[0];
  const tail = out.children[1];
  // inner children resolved first
  eq(inner.children[0].x, 0, "inner r0.x");  eq(inner.children[0].y, 0, "inner r0.y");
  eq(inner.children[1].x, 30, "inner r1.x"); eq(inner.children[1].y, 0, "inner r1.y");
  // outer placement
  eq(inner.x, 0, "inner.x"); eq(inner.y, 0, "inner.y");
  eq(tail.x, 0, "tail.x");   eq(tail.y, 50, "tail.y");
}

// ---------------------------------------------------------------------------
// 5. mode none / no layout -> children untouched.
// ---------------------------------------------------------------------------
section("mode none: children untouched");
{
  const tree = {
    id: "p", type: "group", x: 0, y: 0, width: 100, height: 100,
    children: [{ id: "a", type: "rect", x: 7, y: 9, width: 10, height: 10 }],
  };
  const out = layout(tree);
  eq(out.children[0].x, 7, "untouched x");
  eq(out.children[0].y, 9, "untouched y");
}

console.log(`\n${failed === 0 ? "ALL GREEN" : "RED"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
