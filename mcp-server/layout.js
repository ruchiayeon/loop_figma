// layout.js — auto-layout engine for the shared design document.
//
// Pure function: layout(node) returns a DEEP COPY of the subtree with each
// container's children x/y recomputed when that container has an auto-layout
// config (layout.mode "horizontal" or "vertical"). The input is never mutated.
//
// Coordinate model (matches store.js): a child's x/y are RELATIVE to its
// parent's origin. So auto-layout positions children inside the parent's
// content box, where the content box is the parent's width/height shrunk by
// padding.
//
// Resolution order is depth-first / inner-first: we lay out a node's children
// (recursively) BEFORE positioning them, so a nested auto-layout frame settles
// its own children first and the outer pass then places the (already-resolved)
// inner frame using its width/height.

const DEFAULT_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Normalize a (possibly partial) layout config to concrete values.
function normalizeLayout(layout) {
  const l = layout || {};
  const p = l.padding || {};
  return {
    mode: l.mode === "horizontal" || l.mode === "vertical" ? l.mode : "none",
    gap: num(l.gap, 0),
    padding: {
      top: num(p.top, DEFAULT_PADDING.top),
      right: num(p.right, DEFAULT_PADDING.right),
      bottom: num(p.bottom, DEFAULT_PADDING.bottom),
      left: num(p.left, DEFAULT_PADDING.left),
    },
    align: ["start", "center", "end"].includes(l.align) ? l.align : "start",
    justify: ["start", "center", "end", "space-between"].includes(l.justify)
      ? l.justify
      : "start",
  };
}

// Cross-axis offset for a single child given the available cross extent.
function crossOffset(align, paddingStart, available, childSize) {
  if (align === "center") return paddingStart + (available - childSize) / 2;
  if (align === "end") return paddingStart + (available - childSize);
  return paddingStart; // "start"
}

// Place children along the main axis. Returns the leading offset for the first
// child plus the per-child spacing strategy.
function arrangeChildren(children, cfg, parent) {
  const horizontal = cfg.mode === "horizontal";
  const { padding } = cfg;

  // Content box on each axis.
  const contentW = num(parent.width, 0) - padding.left - padding.right;
  const contentH = num(parent.height, 0) - padding.top - padding.bottom;

  // Main-axis content extent and cross-axis content extent.
  const mainContent = horizontal ? contentW : contentH;
  const crossContent = horizontal ? contentH : contentW;
  const crossPadStart = horizontal ? padding.top : padding.left;
  const mainPadStart = horizontal ? padding.left : padding.top;

  const mainSize = (c) => (horizontal ? num(c.width, 0) : num(c.height, 0));
  const crossSize = (c) => (horizontal ? num(c.height, 0) : num(c.width, 0));

  const n = children.length;
  const sumMain = children.reduce((acc, c) => acc + mainSize(c), 0);

  // Determine starting offset and the gap between consecutive children.
  let cursor = mainPadStart;
  let gap = cfg.gap;

  if (cfg.justify === "space-between" && n > 1) {
    const free = mainContent - sumMain;
    gap = free / (n - 1);
    cursor = mainPadStart;
  } else {
    // start / center / end offset the whole run as a block.
    const runExtent = sumMain + cfg.gap * (n > 0 ? n - 1 : 0);
    if (cfg.justify === "center") {
      cursor = mainPadStart + (mainContent - runExtent) / 2;
    } else if (cfg.justify === "end") {
      cursor = mainPadStart + (mainContent - runExtent);
    } else {
      cursor = mainPadStart; // start
    }
    gap = cfg.gap;
  }

  return children.map((child) => {
    const main = cursor;
    const cross = crossOffset(cfg.align, crossPadStart, crossContent, crossSize(child));
    cursor += mainSize(child) + gap;
    if (horizontal) {
      return { ...child, x: main, y: cross };
    }
    return { ...child, x: cross, y: main };
  });
}

// Deep-copy a node (structural clone of the tree). We only ever touch plain
// JSON-shaped design nodes, so a recursive copy is sufficient and keeps the
// function pure.
function cloneNode(node) {
  const copy = { ...node };
  if (Array.isArray(node.children)) {
    copy.children = node.children.map(cloneNode);
  }
  return copy;
}

// Recursively resolve auto-layout, inner-first.
function resolve(node) {
  // Resolve children's own layouts first (depth-first), so nested auto-layout
  // frames have final width/height before we position them.
  let children = Array.isArray(node.children)
    ? node.children.map(resolve)
    : undefined;

  const cfg = normalizeLayout(node.layout);
  if (children && (cfg.mode === "horizontal" || cfg.mode === "vertical")) {
    children = arrangeChildren(children, cfg, node);
  }

  const out = { ...node };
  if (children) out.children = children;
  return out;
}

// Public API: pure layout pass over a single node/subtree.
export function layout(node) {
  if (node == null || typeof node !== "object") return node;
  return resolve(cloneNode(node));
}
