import { createNode, loadDesign, saveDesign } from "./store.js";
// reset to empty without delete (overwrite in place)
saveDesign({ version: 1, document: { width: 1200, height: 800, background: "#ffffff" }, nodes: [] });
createNode({ type: "rect", x: 80, y: 60, width: 520, height: 320, fill: "#ffffff", stroke: "#e5e7eb", strokeWidth: 2, name: "Card" });
createNode({ type: "rect", x: 80, y: 60, width: 520, height: 70, fill: "#4f46e5", strokeWidth: 0, name: "Header" });
createNode({ type: "text", x: 110, y: 78, text: "Mini-Figma", fontSize: 30, color: "#ffffff", name: "Title" });
createNode({ type: "ellipse", x: 500, y: 72, width: 44, height: 44, fill: "#22d3ee", strokeWidth: 0, name: "Avatar" });
createNode({ type: "text", x: 110, y: 170, text: "Built by an agent via MCP.", fontSize: 22, color: "#374151", name: "Body" });
createNode({ type: "line", x: 110, y: 230, x2: 560, y2: 230, stroke: "#e5e7eb", strokeWidth: 2, name: "Divider" });
createNode({ type: "rect", x: 110, y: 270, width: 150, height: 56, fill: "#4f46e5", strokeWidth: 0, name: "Primary btn" });
createNode({ type: "text", x: 140, y: 286, text: "Confirm", fontSize: 20, color: "#ffffff", name: "Primary label" });
createNode({ type: "rect", x: 280, y: 270, width: 150, height: 56, fill: "#ffffff", stroke: "#4f46e5", strokeWidth: 2, name: "Ghost btn" });
createNode({ type: "text", x: 320, y: 286, text: "Cancel", fontSize: 20, color: "#4f46e5", name: "Ghost label" });
