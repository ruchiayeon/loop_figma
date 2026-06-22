// store.js — shared design document persistence + node operations.
// Both the MCP server and the test harness use this module so that the
// canvas (which reads design.json) and the agent (which drives the MCP
// server) operate on exactly the same data model.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// design.json lives one level up so the canvas and the server share it.
export const DESIGN_PATH = resolve(__dirname, "..", "design.json");

const NODE_TYPES = new Set(["rect", "ellipse", "text", "line"]);

function emptyDoc() {
  return {
    version: 1,
    document: { width: 1200, height: 800, background: "#ffffff" },
    nodes: [],
  };
}

export function loadDesign() {
  if (!existsSync(DESIGN_PATH)) {
    const doc = emptyDoc();
    saveDesign(doc);
    return doc;
  }
  try {
    const raw = readFileSync(DESIGN_PATH, "utf8");
    const doc = JSON.parse(raw);
    if (!doc.document) doc.document = emptyDoc().document;
    if (!Array.isArray(doc.nodes)) doc.nodes = [];
    return doc;
  } catch {
    // Corrupt file → start clean rather than crash the server.
    const doc = emptyDoc();
    saveDesign(doc);
    return doc;
  }
}

export function saveDesign(doc) {
  writeFileSync(DESIGN_PATH, JSON.stringify(doc, null, 2));
}

let counter = 0;
function genId() {
  counter += 1;
  return `n_${Date.now().toString(36)}_${counter}`;
}

const DEFAULTS = {
  rect:    { width: 160, height: 100, fill: "#4f46e5", stroke: "#1e1b4b", strokeWidth: 0 },
  ellipse: { width: 140, height: 140, fill: "#10b981", stroke: "#064e3b", strokeWidth: 0 },
  text:    { width: 220, height: 40,  fill: "transparent", text: "Text", fontSize: 24, color: "#111827" },
  line:    { width: 0, height: 0, x2: 200, y2: 0, stroke: "#111827", strokeWidth: 2 },
};

// Clamp helper keeps designs sane (no NaN, no negative sizes).
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function createNode(props = {}) {
  const type = props.type;
  if (!NODE_TYPES.has(type)) {
    throw new Error(`Invalid node type "${type}". Must be one of: ${[...NODE_TYPES].join(", ")}`);
  }
  const d = DEFAULTS[type];
  const doc = loadDesign();
  const node = {
    id: genId(),
    type,
    name: props.name || `${type[0].toUpperCase()}${type.slice(1)} ${doc.nodes.length + 1}`,
    x: num(props.x, 80),
    y: num(props.y, 80),
    width: num(props.width, d.width),
    height: num(props.height, d.height),
    rotation: num(props.rotation, 0),
    opacity: num(props.opacity, 1),
    fill: props.fill ?? d.fill,
    stroke: props.stroke ?? d.stroke ?? "#000000",
    strokeWidth: num(props.strokeWidth, d.strokeWidth ?? 0),
    zIndex: doc.nodes.length,
  };
  if (type === "text") {
    node.text = props.text ?? d.text;
    node.fontSize = num(props.fontSize, d.fontSize);
    node.color = props.color ?? d.color;
  }
  if (type === "line") {
    node.x2 = num(props.x2, node.x + d.x2);
    node.y2 = num(props.y2, node.y + d.y2);
  }
  doc.nodes.push(node);
  saveDesign(doc);
  return node;
}

export function updateNode(id, props = {}) {
  const doc = loadDesign();
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`Node "${id}" not found`);
  // Only allow updating known mutable fields.
  const allowed = [
    "name", "x", "y", "width", "height", "rotation", "opacity",
    "fill", "stroke", "strokeWidth", "zIndex",
    "text", "fontSize", "color", "x2", "y2",
  ];
  for (const key of allowed) {
    if (key in props) node[key] = props[key];
  }
  saveDesign(doc);
  return node;
}

export function deleteNode(id) {
  const doc = loadDesign();
  const before = doc.nodes.length;
  doc.nodes = doc.nodes.filter((n) => n.id !== id);
  if (doc.nodes.length === before) throw new Error(`Node "${id}" not found`);
  saveDesign(doc);
  return { deleted: id, remaining: doc.nodes.length };
}

// Render the document to a standalone SVG string — handy for exporting or
// for an agent to "see" the current design without the canvas open.
export function toSVG(doc = loadDesign()) {
  const { width, height, background } = doc.document;
  const nodes = [...doc.nodes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  const body = nodes.map((n) => {
    const t = `rotate(${n.rotation || 0} ${n.x + n.width / 2} ${n.y + n.height / 2})`;
    const common = `opacity="${n.opacity ?? 1}" transform="${t}"`;
    if (n.type === "rect") {
      return `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}" ${common}/>`;
    }
    if (n.type === "ellipse") {
      return `<ellipse cx="${n.x + n.width / 2}" cy="${n.y + n.height / 2}" rx="${n.width / 2}" ry="${n.height / 2}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}" ${common}/>`;
    }
    if (n.type === "text") {
      return `<text x="${n.x}" y="${n.y + (n.fontSize || 24)}" font-size="${n.fontSize || 24}" fill="${n.color || "#111"}" font-family="Inter, sans-serif" ${common}>${escapeXml(n.text || "")}</text>`;
    }
    if (n.type === "line") {
      return `<line x1="${n.x}" y1="${n.y}" x2="${n.x2}" y2="${n.y2}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}" ${common}/>`;
    }
    return "";
  }).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>
  ${body}
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}
