// to-code.mjs — design document -> JSX string ("code componentization").
//
// One half of an INVERTIBLE mapping (see from-code.mjs for the other half).
// Emits a single self-contained React function component named `Design` that
// renders the node tree using the PINNED vocabulary + inline styles. Output is
// fully deterministic (stable key order, fixed rounding) so that
//   fromCode(toCode(design))  ===  design   (after the documented normalize()).
//
// Vocabulary (1:1 with node types):
//   frame  -> <div data-node="frame">
//   group  -> <div data-node="group">
//   rect   -> <div data-node="rect">
//   ellipse-> <div data-node="ellipse">   (+ borderRadius:'50%')
//   text   -> <span data-node="text">TEXT</span>
//   image  -> <img data-node="image" src=... />
//   line   -> <div data-node="line">
//
// Anything that lacks a CLEAN, lossless CSS inverse is carried on a data-*
// attribute (name, rotation, zIndex, x2/y2, clipsContent, layout, the exact
// numeric x/y) so that from-code.mjs can recover it without guessing and so
// that normalize() can stay tiny (and therefore the round-trip gate stays
// honest). CSS styles are emitted purely for VISUALIZATION.

export const VERSION = 1;

// ---- helpers ---------------------------------------------------------------

// Round a number to an integer-ish value. px coordinates/sizes round to whole
// pixels; this matches normalize() in the test and keeps output stable.
function r(n) {
  const v = Number(n);
  return Number.isFinite(n) ? Math.round(v) : 0;
}

// opacity is fractional — keep up to 3 decimals, drop trailing zeros.
function rf(n) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return Math.round(v * 1000) / 1000;
}

function esc(s) {
  // Escape &,<,> for HTML correctness AND ( ) { } so that span text can never
  // forge the `);}` / `); }` body-terminator sentinel that from-code's
  // component-function-body extractor regex relies on. unescapeText() inverts
  // all of these. (Entity names mirror HTML5 named refs for ( ) { }.)
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\(/g, "&lpar;")
    .replace(/\)/g, "&rpar;")
    .replace(/\{/g, "&lcub;")
    .replace(/\}/g, "&rcub;");
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A component master is a frame-like container (own box + children). It renders
// as a <div> inside its OWN named React function (see emitComponentFn). An
// instance is a leaf USE of a component, rendered as <Comp_<safeId> .../>.
const CONTAINER = new Set(["frame", "group", "component"]);

// Deterministic, lossy-but-cosmetic React function name for a component master.
// The REAL component id is always carried on data-* attributes (data-node-id on
// the component, data-instance-of on instances), so un-sanitizing the name is
// never required by from-code.mjs.
export function compName(id) {
  const safe = String(id == null ? "" : id).replace(/[^A-Za-z0-9_]/g, "_");
  return `Comp_${safe}`;
}

function isFlex(node) {
  return node && node.layout && node.layout.mode && node.layout.mode !== "none";
}

const FLEX_ALIGN = { start: "flex-start", center: "center", end: "flex-end" };
const FLEX_JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  "space-between": "space-between",
};

// Build the inline style object (as a deterministic JS-object literal string).
// `parentFlex` tells us whether x/y become absolute positioning (none parent)
// or are dropped from CSS (flex parent — the children flow).
function styleLiteral(node, parentFlex) {
  const props = [];
  // position / coordinates
  if (parentFlex) {
    props.push(["position", "relative"]);
  } else {
    props.push(["position", "absolute"]);
    props.push(["left", `${r(node.x)}px`]);
    props.push(["top", `${r(node.y)}px`]);
  }
  // size
  props.push(["width", `${r(node.width)}px`]);
  props.push(["height", `${r(node.height)}px`]);
  // opacity
  props.push(["opacity", rf(node.opacity == null ? 1 : node.opacity)]);
  // rotation
  if (Number(node.rotation)) props.push(["transform", `rotate(${r(node.rotation)}deg)`]);

  // fill -> background-color (always emit so transparent round-trips clearly).
  props.push(["backgroundColor", node.fill == null ? "transparent" : String(node.fill)]);

  // stroke + strokeWidth -> border. ALWAYS emit (even width 0) so the stroke
  // color is recoverable at width 0.
  const sw = r(node.strokeWidth || 0);
  const stroke = node.stroke == null ? "transparent" : String(node.stroke);
  props.push(["border", `${sw}px solid ${stroke}`]);

  if (node.type === "ellipse") props.push(["borderRadius", "50%"]);

  if (node.type === "text") {
    props.push(["fontSize", `${r(node.fontSize == null ? 16 : node.fontSize)}px`]);
    props.push(["color", node.color == null ? "#000000" : String(node.color)]);
  }

  // flex container styling
  if (isFlex(node)) {
    const L = node.layout;
    props.push(["display", "flex"]);
    props.push(["flexDirection", L.mode === "horizontal" ? "row" : "column"]);
    props.push(["gap", `${r(L.gap || 0)}px`]);
    const p = L.padding || {};
    props.push([
      "padding",
      `${r(p.top || 0)}px ${r(p.right || 0)}px ${r(p.bottom || 0)}px ${r(p.left || 0)}px`,
    ]);
    props.push(["alignItems", FLEX_ALIGN[L.align] || "flex-start"]);
    props.push(["justifyContent", FLEX_JUSTIFY[L.justify] || "flex-start"]);
  }

  const inner = props.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  return `{ ${inner} }`;
}

// data-* attributes carrying the exact, lossless values.
function dataAttrs(node, parentFlex) {
  const a = [];
  a.push(`data-node="${escAttr(node.type)}"`);
  a.push(`data-node-id="${escAttr(node.id)}"`);
  a.push(`data-name="${escAttr(node.name == null ? "" : node.name)}"`);
  // Exact numeric coords always carried so flex children survive too.
  a.push(`data-x="${r(node.x)}"`);
  a.push(`data-y="${r(node.y)}"`);
  a.push(`data-rotation="${r(node.rotation || 0)}"`);
  a.push(`data-z="${r(node.zIndex == null ? 0 : node.zIndex)}"`);
  if (node.type === "line") {
    a.push(`data-x2="${r(node.x2)}"`);
    a.push(`data-y2="${r(node.y2)}"`);
  }
  // frame AND component both carry clipsContent (component is frame-like).
  if (node.type === "frame" || node.type === "component") {
    a.push(`data-clips="${node.clipsContent === false ? "0" : "1"}"`);
  }
  if (CONTAINER.has(node.type)) {
    const L = node.layout || { mode: "none" };
    a.push(`data-layout="${escAttr(JSON.stringify(L))}"`);
  }
  return a.join(" ");
}

function indent(depth) {
  return "  ".repeat(depth);
}

// Render a sibling list in deterministic (array) order. Array order IS the
// authoritative ordering per the contract; zIndex is carried via data-z.
function renderList(nodes, parentFlex, depth) {
  return nodes.map((n) => renderNode(n, parentFlex, depth)).join("\n");
}

// An instance renders as a USAGE of its component's named function. All of the
// instance's own authoring fields (placement x/y, name, z, size, overrides,
// componentId) are carried on data-* so from-code recovers the instance node
// exactly. style is emitted for visualization only.
function renderInstance(node, parentFlex, depth) {
  const pad = indent(depth);
  const style = styleLiteral(node, parentFlex);
  const a = [];
  a.push(`data-node="instance"`);
  a.push(`data-node-id="${escAttr(node.id)}"`);
  a.push(`data-name="${escAttr(node.name == null ? "" : node.name)}"`);
  a.push(`data-instance-of="${escAttr(node.componentId == null ? "" : node.componentId)}"`);
  a.push(`data-x="${r(node.x)}"`);
  a.push(`data-y="${r(node.y)}"`);
  a.push(`data-rotation="${r(node.rotation || 0)}"`);
  a.push(`data-z="${r(node.zIndex == null ? 0 : node.zIndex)}"`);
  const ov = node.overrides && typeof node.overrides === "object" ? node.overrides : {};
  a.push(`data-overrides="${escAttr(JSON.stringify(ov))}"`);
  const Name = compName(node.componentId);
  return `${pad}<${Name} ${a.join(" ")} style={${style}} />`;
}

// A component master, where it SITS in the tree, is replaced by a self-closing
// placement marker. The component's full definition (box props + children) is
// emitted separately as a named function (emitComponentFn). data-node-id here is
// the component's id so from-code can splice the parsed function body back in at
// this exact tree position.
function renderComponentPlacement(node, parentFlex, depth) {
  const pad = indent(depth);
  const a = [];
  a.push(`data-node="component-placement"`);
  a.push(`data-node-id="${escAttr(node.id)}"`);
  const Name = compName(node.id);
  return `${pad}<${Name} ${a.join(" ")} />`;
}

function renderNode(node, parentFlex, depth) {
  if (node.type === "instance") return renderInstance(node, parentFlex, depth);
  if (node.type === "component") return renderComponentPlacement(node, parentFlex, depth);

  const pad = indent(depth);
  const style = styleLiteral(node, parentFlex);
  const data = dataAttrs(node, parentFlex);

  if (node.type === "text") {
    const txt = esc(node.text == null ? "" : node.text);
    return `${pad}<span ${data} style={${style}}>${txt}</span>`;
  }

  if (node.type === "image") {
    const src = escAttr(node.src == null ? "" : node.src);
    return `${pad}<img ${data} src="${src}" style={${style}} />`;
  }

  if (node.type === "line") {
    return `${pad}<div ${data} style={${style}}></div>`;
  }

  if (CONTAINER.has(node.type)) {
    const kids = Array.isArray(node.children) ? node.children : [];
    if (!kids.length) {
      return `${pad}<div ${data} style={${style}}></div>`;
    }
    const childFlex = isFlex(node);
    const body = renderList(kids, childFlex, depth + 1);
    return `${pad}<div ${data} style={${style}}>\n${body}\n${pad}</div>`;
  }

  // rect / ellipse and any leaf primitive.
  return `${pad}<div ${data} style={${style}}></div>`;
}

// Render the INNER box <div> of a component master (its definition body). This
// is what lives inside `function Comp_<safeId>() { return (...) }`. The div
// carries data-node="component" + the master's full box props + children. It is
// positioned at the component's OWN x/y (its placement in the parent tree is a
// separate self-closing marker), so parentFlex=false here.
function renderComponentBody(node, depth) {
  const pad = indent(depth);
  const style = styleLiteral(node, false);
  const data = dataAttrs(node, false);
  const kids = Array.isArray(node.children) ? node.children : [];
  if (!kids.length) return `${pad}<div ${data} style={${style}}></div>`;
  const childFlex = isFlex(node);
  const body = renderList(kids, childFlex, depth + 1);
  return `${pad}<div ${data} style={${style}}>\n${body}\n${pad}</div>`;
}

// Collect every component master in the tree (depth-first, including components
// nested inside frames/groups/other components). Deterministic order = tree
// order. A component's own children are searched too (a component may contain a
// nested component definition).
function collectComponents(nodes, acc = []) {
  for (const n of nodes) {
    if (n && n.type === "component") acc.push(n);
    if (Array.isArray(n && n.children)) collectComponents(n.children, acc);
  }
  return acc;
}

// Emit one standalone named React function for a component master.
function emitComponentFn(node) {
  const Name = compName(node.id);
  const body = renderComponentBody(node, 2);
  return (
    `function ${Name}() {\n` +
    `  return (\n` +
    body +
    `\n  );\n` +
    `}\n`
  );
}

/**
 * toCode(design) -> string of JSX.
 *
 * Produces a self-contained React function component `Design`. The root <div>
 * carries the document (width/height/background) on data-doc-* attributes so
 * from-code.mjs can recover them. Top-level nodes are children of the root and
 * are positioned absolutely (the canvas is a `none`-layout parent).
 */
export function toCode(design) {
  const doc = (design && design.document) || {};
  const width = r(doc.width == null ? 1200 : doc.width);
  const height = r(doc.height == null ? 800 : doc.height);
  const background = doc.background == null ? "#ffffff" : String(doc.background);
  const version = design && design.version != null ? design.version : VERSION;

  const nodes = Array.isArray(design && design.nodes) ? design.nodes : [];
  const body = nodes.length ? renderList(nodes, false, 3) + "\n" : "";

  const rootStyle =
    `{ position: "relative", width: ${JSON.stringify(`${width}px`)}, ` +
    `height: ${JSON.stringify(`${height}px`)}, backgroundColor: ${JSON.stringify(background)} }`;

  // Each component master becomes its OWN named function declaration, emitted
  // ONCE before Design regardless of how many instances reference it.
  const componentFns = collectComponents(nodes).map(emitComponentFn).join("\n");
  const componentPrelude = componentFns ? componentFns + "\n" : "";

  return (
    componentPrelude +
    `function Design() {\n` +
    `  return (\n` +
    `    <div data-doc="root" data-doc-version="${version}" ` +
    `data-doc-width="${width}" data-doc-height="${height}" ` +
    `data-doc-background="${escAttr(background)}" style={${rootStyle}}>\n` +
    body +
    `    </div>\n` +
    `  );\n` +
    `}\n`
  );
}
