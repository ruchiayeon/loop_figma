// store.js — shared design document persistence + node operations.
// Both the MCP server and the test harness use this module so that the
// canvas (which reads design.json) and the agent (which drives the MCP
// server) operate on exactly the same data model.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { layout } from "./layout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// design.json lives one level up so the canvas and the server share it.
export const DESIGN_PATH = resolve(__dirname, "..", "design.json");

const NODE_TYPES = new Set(["rect", "ellipse", "text", "line", "frame", "group", "image", "component", "instance"]);
// Only these node types may contain children. Parenting under anything else
// would orphan the child (the renderer never recurses into primitives).
// A "component" is a frame-like master definition, so it may contain children.
// An "instance" is a leaf in the AUTHORING doc (its children are resolved from
// its master at render time), so it is NOT a container here.
const CONTAINER_TYPES = new Set(["frame", "group", "component"]);

// Depth cap for instance expansion — guards against component-recursion cycles
// (an instance whose master transitively contains an instance of itself).
const MAX_INSTANCE_DEPTH = 16;

// Renumber zIndex to match array position so array order is the single source
// of truth for z-order. Call after any structural change to a sibling list.
function renumberZIndex(list) {
  list.forEach((node, i) => { node.zIndex = i; });
}

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
  // frame: a container with its own background fill, explicit size, clips children by default.
  frame:   { width: 400, height: 300, fill: "#f3f4f6", stroke: "#d1d5db", strokeWidth: 0 },
  // group: a logical container with NO own background; size is derived/optional.
  group:   { width: 0, height: 0, fill: "transparent", stroke: "transparent", strokeWidth: 0 },
  // image: a leaf that renders an <image href> at its box; fill is transparent.
  image:   { width: 200, height: 150, fill: "transparent", stroke: "transparent", strokeWidth: 0, src: "" },
  // component: a frame-like MASTER definition; container with its own box.
  component: { width: 400, height: 300, fill: "transparent", stroke: "transparent", strokeWidth: 0 },
  // instance: a USE of a component; size defaults to the master's at resolve time.
  instance:  { width: 0, height: 0, fill: "transparent", stroke: "transparent", strokeWidth: 0 },
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

  // Determine the sibling list this node will join. With a parentId the node
  // becomes a CHILD (coords relative to that parent's origin); otherwise it is
  // a top-level node (coords relative to the canvas, as before).
  let siblings;
  if (props.parentId != null) {
    const found = findNode(props.parentId, doc);
    if (!found) throw new Error(`Parent node "${props.parentId}" not found`);
    if (!CONTAINER_TYPES.has(found.node.type)) {
      throw new Error(`Parent node "${props.parentId}" is a ${found.node.type}, which cannot contain children. Only frame or group can be a parent.`);
    }
    if (!Array.isArray(found.node.children)) found.node.children = [];
    siblings = found.node.children;
  } else {
    siblings = doc.nodes;
  }

  const node = {
    id: genId(),
    type,
    name: props.name || `${type[0].toUpperCase()}${type.slice(1)} ${siblings.length + 1}`,
    x: num(props.x, 80),
    y: num(props.y, 80),
    width: num(props.width, d.width),
    height: num(props.height, d.height),
    rotation: num(props.rotation, 0),
    opacity: num(props.opacity, 1),
    fill: props.fill ?? d.fill,
    stroke: props.stroke ?? d.stroke ?? "#000000",
    strokeWidth: num(props.strokeWidth, d.strokeWidth ?? 0),
    zIndex: siblings.length,
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
  if (type === "image") {
    node.src = props.src ?? d.src;
  }
  if (type === "frame") {
    // clipsContent is a boolean (not numeric) — default true.
    node.clipsContent = props.clipsContent ?? true;
    // Optional auto-layout config on frames (see layout.js for the schema).
    if (props.layout && typeof props.layout === "object") node.layout = props.layout;
    node.children = [];
  }
  if (type === "group") {
    if (props.layout && typeof props.layout === "object") node.layout = props.layout;
    node.children = [];
  }
  if (type === "component") {
    // A component master behaves like a frame: own box, optional clip, children.
    node.clipsContent = props.clipsContent ?? true;
    if (props.layout && typeof props.layout === "object") node.layout = props.layout;
    node.children = [];
  }
  if (type === "instance") {
    // An instance must reference an existing component master.
    const componentId = props.componentId;
    if (componentId == null) {
      throw new Error(`Cannot create instance: "componentId" is required`);
    }
    const target = findNode(componentId, doc);
    if (!target) {
      throw new Error(`Cannot create instance: component "${componentId}" not found`);
    }
    if (target.node.type !== "component") {
      throw new Error(`Cannot create instance: node "${componentId}" is a ${target.node.type}, not a component`);
    }
    node.componentId = componentId;
    // overrides: { masterChildId: { ...partial props } }. Default to empty.
    node.overrides = (props.overrides && typeof props.overrides === "object") ? props.overrides : {};
    // width/height default to the master's box (overridable by explicit props).
    if (props.width == null) node.width = num(target.node.width, d.width);
    if (props.height == null) node.height = num(target.node.height, d.height);
    // An instance has NO authored children — it is a leaf in the authoring doc.
  }
  // Note: parentId is NOT stored on the node. The children array is the single
  // source of truth for the tree, so a stored parentId would go stale on move.

  siblings.push(node);
  // Re-resolve auto-layout: if this node joined an auto-layout container (or is
  // itself one), its/sibling coords must reflect the engine. applyLayout saves.
  applyLayout(doc);
  // Return the resolved node (applyLayout replaced `node` with a deep copy).
  return findNode(node.id, doc).node;
}

// Tree walk: find a node anywhere in the tree by id. Returns
// { node, parent, siblings } where `parent` is the parent node (null for
// top-level nodes) and `siblings` is the array the node lives in (doc.nodes
// for top-level). Searches the doc passed in (do NOT load a fresh copy here,
// or callers' mutations would be applied to a different object than they save).
export function findNode(id, doc = loadDesign()) {
  function walk(siblings, parent) {
    for (const node of siblings) {
      if (node.id === id) return { node, parent, siblings };
      if (Array.isArray(node.children)) {
        const hit = walk(node.children, node);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(doc.nodes, null);
}

// Collect a node's id plus every descendant id (used for cycle prevention).
function collectSubtreeIds(node, acc = new Set()) {
  acc.add(node.id);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectSubtreeIds(child, acc);
  }
  return acc;
}

export function updateNode(id, props = {}) {
  const doc = loadDesign();
  const found = findNode(id, doc);
  if (!found) throw new Error(`Node "${id}" not found`);
  const { node } = found;
  // Only allow updating known mutable fields.
  const allowed = [
    "name", "x", "y", "width", "height", "rotation", "opacity",
    "fill", "stroke", "strokeWidth", "zIndex", "clipsContent",
    "text", "fontSize", "color", "x2", "y2", "src", "layout",
    "componentId", "overrides",
  ];
  for (const key of allowed) {
    if (key in props) node[key] = props[key];
  }
  // A size change on a child, or a layout change on a container, can shift the
  // resolved positions of auto-layout siblings/children. Re-resolve + save.
  applyLayout(doc);
  return findNode(id, doc).node;
}

export function deleteNode(id) {
  const doc = loadDesign();
  const found = findNode(id, doc);
  if (!found) throw new Error(`Node "${id}" not found`);
  // Removing the node from its sibling array drops its entire subtree with it.
  const { siblings } = found;
  const idx = siblings.findIndex((n) => n.id === id);
  siblings.splice(idx, 1);
  // Keep zIndex contiguous and array-order-authoritative for the survivors.
  renumberZIndex(siblings);
  // Re-resolve auto-layout: removing a child from an auto-layout container shifts
  // the survivors' resolved coords. Like the other mutators, applyLayout saves.
  applyLayout(doc);
  return { deleted: id, remaining: countNodes(doc) };
}

// Total node count across the whole tree.
function countNodes(doc) {
  let n = 0;
  function walk(list) {
    for (const node of list) {
      n += 1;
      if (Array.isArray(node.children)) walk(node.children);
    }
  }
  walk(doc.nodes);
  return n;
}

// Reparent a node. newParentId === null moves it to the top level (doc.nodes).
// index is the insertion position within the destination list (defaults to end).
// Throws if newParentId is the node itself or any of its descendants — that
// would create a cycle in the tree.
//
// Coordinate choice: x/y are KEPT AS-IS on reparent. Coordinates are relative
// to the parent's origin, so the node's on-screen position may shift; callers
// who want to preserve absolute position should adjust x/y themselves. We keep
// it simple and predictable rather than auto-rebasing.
export function moveNode(id, newParentId = null, index) {
  const doc = loadDesign();
  const found = findNode(id, doc);
  if (!found) throw new Error(`Node "${id}" not found`);
  const { node, siblings: oldSiblings } = found;

  let destList;
  if (newParentId == null) {
    destList = doc.nodes;
  } else {
    const forbidden = collectSubtreeIds(node);
    if (forbidden.has(newParentId)) {
      throw new Error(`Cannot move node "${id}" into itself or one of its descendants`);
    }
    const dest = findNode(newParentId, doc);
    if (!dest) throw new Error(`New parent node "${newParentId}" not found`);
    if (!CONTAINER_TYPES.has(dest.node.type)) {
      throw new Error(`New parent node "${newParentId}" is a ${dest.node.type}, which cannot contain children. Only frame or group can be a parent.`);
    }
    if (!Array.isArray(dest.node.children)) dest.node.children = [];
    destList = dest.node.children;
  }

  // Detach from current location.
  const oldIdx = oldSiblings.findIndex((n) => n.id === id);
  oldSiblings.splice(oldIdx, 1);

  // Insert at requested index (clamped) or append.
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, destList.length)) : destList.length;
  destList.splice(at, 0, node);

  // Array order is authoritative for z-order; renumber both affected lists so
  // the renderer's (zIndex ?? index) reflects the new positions. oldSiblings
  // and destList may be the same array (reorder within one parent) — renumber
  // destList last so it wins.
  renumberZIndex(oldSiblings);
  renumberZIndex(destList);

  // Reparenting can place the node into (or pull it out of) an auto-layout
  // container; re-resolve so coords match the engine, then save.
  applyLayout(doc);
  return findNode(id, doc).node;
}

// Resolve ALL auto-layout containers in the document, top-down, and persist the
// recomputed child x/y. layout.js is the single source of truth: it walks the
// whole tree (inner-first per subtree) and overwrites children of any container
// whose layout.mode is "horizontal"/"vertical". Containers with no layout (or
// mode "none") are left untouched, so explicit-coordinate frames are stable.
// Idempotent: positions derive from sizes+config, never from prior positions.
export function applyLayout(doc = loadDesign()) {
  doc.nodes = doc.nodes.map((n) => layout(n));
  saveDesign(doc);
  return doc;
}

// Set (merge) an override patch for one master child on one instance, then save.
// Existing patch for that child is shallow-merged with the new props so callers
// can set fields incrementally. Returns the updated instance node.
export function setOverride(instanceId, masterChildId, props = {}) {
  const doc = loadDesign();
  const found = findNode(instanceId, doc);
  if (!found) throw new Error(`Instance "${instanceId}" not found`);
  if (found.node.type !== "instance") {
    throw new Error(`Node "${instanceId}" is a ${found.node.type}, not an instance`);
  }
  if (masterChildId == null) throw new Error(`set_override requires a masterChildId`);
  const node = found.node;
  if (!node.overrides || typeof node.overrides !== "object") node.overrides = {};
  node.overrides[masterChildId] = { ...(node.overrides[masterChildId] || {}), ...props };
  saveDesign(doc);
  return findNode(instanceId, doc).node;
}

// Deep clone a plain design node (structural copy of the subtree).
function deepClone(node) {
  const copy = { ...node };
  if (Array.isArray(node.children)) copy.children = node.children.map(deepClone);
  return copy;
}

// Find a component master by id within a doc's node tree.
function findComponent(componentId, doc) {
  const hit = findNode(componentId, doc);
  return hit && hit.node.type === "component" ? hit.node : null;
}

// Apply an instance's overrides to a freshly-cloned child subtree and rewrite
// ids to be instance-derived (`${instanceId}:${masterId}`). Recurses into the
// master's nested children. The override map matches by the MASTER child id.
function applyOverridesAndReid(child, instanceId, overrides) {
  const masterId = child.id;
  const patch = overrides && overrides[masterId];
  // Apply the override patch (shallow merge of known props) onto the clone.
  if (patch && typeof patch === "object") Object.assign(child, patch);
  // Rewrite id for rendering only (authoring doc keeps master + instance nodes).
  child.id = `${instanceId}:${masterId}`;
  if (Array.isArray(child.children)) {
    child.children = child.children.map((c) => applyOverridesAndReid(c, instanceId, overrides));
  }
  return child;
}

// Expand a single instance node into a GROUP positioned at the instance's x/y,
// whose children are deep-cloned master children with overrides applied. Nested
// instances inside the master are expanded recursively (depth-capped).
function expandInstance(node, doc, depth, chain) {
  if (depth > MAX_INSTANCE_DEPTH) {
    throw new Error(`Instance expansion exceeded max depth ${MAX_INSTANCE_DEPTH} (component recursion?)`);
  }
  const master = findComponent(node.componentId, doc);
  if (!master) {
    throw new Error(`Instance "${node.id}" references missing component "${node.componentId}"`);
  }
  // Cycle guard: a component (transitively) instancing itself.
  if (chain.includes(node.componentId)) {
    throw new Error(`Component recursion detected: ${[...chain, node.componentId].join(" -> ")}`);
  }
  const nextChain = [...chain, node.componentId];

  // Deep clone the master's children, apply overrides + reid, then recurse to
  // expand any nested instances within them.
  const masterChildren = Array.isArray(master.children) ? master.children : [];
  const cloned = masterChildren
    .map((c) => applyOverridesAndReid(deepClone(c), node.id, node.overrides))
    .map((c) => expandNode(c, doc, depth + 1, nextChain));

  // The instance renders the WHOLE master (its own background + children), not
  // just the children — so it becomes a frame carrying the master's visual
  // props, positioned at the instance's own x/y. Width/height carry over.
  return {
    id: node.id,
    type: "frame",
    name: node.name || "Instance",
    x: node.x,
    y: node.y,
    width: node.width ?? master.width,
    height: node.height ?? master.height,
    rotation: node.rotation ?? 0,
    opacity: node.opacity ?? 1,
    fill: master.fill ?? "transparent",
    stroke: master.stroke ?? "transparent",
    strokeWidth: master.strokeWidth ?? 0,
    clipsContent: master.clipsContent ?? false,
    zIndex: node.zIndex,
    children: cloned,
  };
}

// Resolve one node for rendering: expand it if it is an instance, otherwise
// recurse into its children (which themselves may be/contain instances).
function expandNode(node, doc, depth, chain) {
  if (node.type === "instance") {
    return expandInstance(node, doc, depth, chain);
  }
  if (Array.isArray(node.children)) {
    return { ...node, children: node.children.map((c) => expandNode(c, doc, depth, chain)) };
  }
  return node;
}

// resolveInstances(doc) -> a NEW render-doc (deep, non-mutating) in which every
// instance node has been replaced by a group containing the deep-cloned content
// of its component master with overrides applied. Recurses for nested instances
// and throws on a component-recursion cycle. The input doc is never mutated.
export function resolveInstances(doc = loadDesign()) {
  const nodes = doc.nodes.map((n) => expandNode(deepClone(n), doc, 0, []));
  return { ...doc, nodes };
}

// Render the document to a standalone SVG string — handy for exporting or
// for an agent to "see" the current design without the canvas open. Instances
// are expanded to their master content first (resolveInstances).
export function toSVG(doc = loadDesign()) {
  const resolved = resolveInstances(doc);
  const { width, height, background } = resolved.document;
  const body = renderNodes(resolved.nodes);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>
  ${body}
</svg>`;
}

// Render a sibling list in z-order. Array order is the source of truth; a
// stable sort by (zIndex ?? index) keeps existing flat designs identical while
// honouring zIndex within a child list when present.
function renderNodes(nodes) {
  const ordered = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => (a.node.zIndex ?? a.index) - (b.node.zIndex ?? b.index) || a.index - b.index)
    .map((e) => e.node);
  return ordered.map(renderNode).join("\n  ");
}

// Render one node. Coordinates are RELATIVE to the parent: we emit a
// <g transform="translate(x,y) rotate(...)"> wrapper so children draw relative
// to this node, and the primitive itself draws at local origin.
function renderNode(n) {
  const w = n.width || 0;
  const h = n.height || 0;
  // Rotation pivots around the node's local center.
  const rot = n.rotation ? ` rotate(${n.rotation} ${w / 2} ${h / 2})` : "";
  const open = `<g transform="translate(${n.x},${n.y})${rot}" opacity="${n.opacity ?? 1}">`;
  const close = `</g>`;

  if (n.type === "rect") {
    return `${open}<rect x="0" y="0" width="${w}" height="${h}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}"/>${close}`;
  }
  if (n.type === "ellipse") {
    return `${open}<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}"/>${close}`;
  }
  if (n.type === "text") {
    const fs = n.fontSize || 24;
    return `${open}<text x="0" y="${fs}" font-size="${fs}" fill="${n.color || "#111"}" font-family="Inter, sans-serif">${escapeXml(n.text || "")}</text>${close}`;
  }
  if (n.type === "line") {
    // Stored x2/y2 are absolute (same space as x/y); make them local.
    return `${open}<line x1="0" y1="0" x2="${(n.x2 ?? n.x) - n.x}" y2="${(n.y2 ?? n.y) - n.y}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}"/>${close}`;
  }
  if (n.type === "image") {
    return `${open}<image href="${escapeXml(n.src || "")}" x="0" y="0" width="${w}" height="${h}"/>${close}`;
  }
  if (n.type === "frame") {
    const bg = `<rect x="0" y="0" width="${w}" height="${h}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}"/>`;
    const kids = Array.isArray(n.children) && n.children.length ? renderNodes(n.children) : "";
    if (n.clipsContent) {
      const clipId = `clip-${n.id}`;
      const clip = `<clipPath id="${clipId}"><rect x="0" y="0" width="${w}" height="${h}"/></clipPath>`;
      return `${open}${clip}${bg}<g clip-path="url(#${clipId})">${kids}</g>${close}`;
    }
    return `${open}${bg}${kids}${close}`;
  }
  if (n.type === "group") {
    // No background; just a transform wrapper around the children.
    const kids = Array.isArray(n.children) && n.children.length ? renderNodes(n.children) : "";
    return `${open}${kids}${close}`;
  }
  if (n.type === "component") {
    // A component master renders frame-like: own bg box, optional clip, children.
    const bg = `<rect x="0" y="0" width="${w}" height="${h}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}"/>`;
    const kids = Array.isArray(n.children) && n.children.length ? renderNodes(n.children) : "";
    if (n.clipsContent) {
      const clipId = `clip-${n.id}`;
      const clip = `<clipPath id="${clipId}"><rect x="0" y="0" width="${w}" height="${h}"/></clipPath>`;
      return `${open}${clip}${bg}<g clip-path="url(#${clipId})">${kids}</g>${close}`;
    }
    return `${open}${bg}${kids}${close}`;
  }
  // Unknown type but with children — still render the subtree so nothing crashes.
  if (Array.isArray(n.children) && n.children.length) {
    return `${open}${renderNodes(n.children)}${close}`;
  }
  return "";
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}
