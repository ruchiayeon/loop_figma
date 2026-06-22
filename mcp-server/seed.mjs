// seed.mjs — writes a sample composition that exercises the TREE model:
// nested frames, an auto-layout button row, text/ellipse/line/image leaves.
// Run:  node mcp-server/seed.mjs   (then Load design.json in the canvas)
import { createNode, saveDesign, setOverride } from "./store.js";

// reset to empty
saveDesign({ version: 1, document: { width: 1200, height: 800, background: "#f3f4f6" }, nodes: [] });

// Card = a clipping frame; children use parent-relative coords.
const card = createNode({
  type: "frame", name: "Card", x: 120, y: 90, width: 520, height: 360,
  fill: "#ffffff", stroke: "#e5e7eb", strokeWidth: 1, clipsContent: true,
});

// Header band inside the card (relative to the card origin).
createNode({ parentId: card.id, type: "rect", name: "Header bg", x: 0, y: 0, width: 520, height: 72, fill: "#4f46e5", strokeWidth: 0 });
createNode({ parentId: card.id, type: "text", name: "Title", x: 28, y: 22, text: "Mini-Figma", fontSize: 28, color: "#ffffff" });
createNode({ parentId: card.id, type: "ellipse", name: "Avatar", x: 452, y: 16, width: 40, height: 40, fill: "#22d3ee", strokeWidth: 0 });

// Body
createNode({ parentId: card.id, type: "text", name: "Body", x: 28, y: 104, text: "Designed by agents, in a loop.", fontSize: 20, color: "#374151" });
createNode({ parentId: card.id, type: "line", name: "Divider", x: 28, y: 156, x2: 492, y2: 156, stroke: "#e5e7eb", strokeWidth: 2 });

// A reusable Button COMPONENT (master) — define once, instance it twice.
const btn = createNode({ type: "component", name: "Button", x: 700, y: 110, width: 150, height: 48, fill: "#4f46e5", strokeWidth: 0, clipsContent: true });
const btnLabel = createNode({ parentId: btn.id, type: "text", name: "label", x: 44, y: 12, text: "Button", fontSize: 18, color: "#ffffff" });

// Auto-layout button row inside the card: a horizontal flex frame holding two INSTANCES.
const row = createNode({
  parentId: card.id, type: "frame", name: "Button row", x: 28, y: 200, width: 320, height: 56,
  fill: "transparent", strokeWidth: 0, clipsContent: false,
  layout: { mode: "horizontal", gap: 16, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "center", justify: "start" },
});
// Two instances of Button; auto-layout positions them, overrides change the label text.
const i1 = createNode({ parentId: row.id, type: "instance", name: "Confirm", componentId: btn.id, x: 0, y: 0 });
const i2 = createNode({ parentId: row.id, type: "instance", name: "Cancel", componentId: btn.id, x: 0, y: 0 });
// Override each instance's label text (match by master child id) — same component, different content.
setOverride(i1.id, btnLabel.id, { text: "Confirm" });
setOverride(i2.id, btnLabel.id, { text: "Cancel" });

console.log("Seeded a nested, auto-layout composition with a Button component + 2 instances into design.json");
