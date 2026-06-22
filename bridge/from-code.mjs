// from-code.mjs — JSX string -> design document ("UI visualization" inverse).
//
// The other half of the INVERTIBLE mapping in to-code.mjs.
//
// ASSUMPTION (documented & relied upon): the input is ONLY EVER the
// well-formed JSX subset produced by toCode() in this same folder. That means:
//   - every element is one of <div>/<span>/<img> with a data-node attribute
//     (plus the single root <div data-doc="root">),
//   - attributes are double-quoted, style is a flat JS-object literal,
//   - tags are balanced and never self-close except <img ... />.
// Because the grammar is this narrow we can parse with a small hand-written
// tag/attribute walker — no JSX parser dependency is needed. The walker would
// reject arbitrary hand-authored JSX; it is not a general parser.

export const VERSION = 1;

// frame/group/component are containers in the AUTHORING doc; an instance is a
// leaf (its children resolve from the master at render time, not here).
const CONTAINER = new Set(["frame", "group", "component"]);

// ---- attribute extraction --------------------------------------------------

function unescapeAttr(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function unescapeText(s) {
  return String(s)
    .replace(/&lpar;/g, "(")
    .replace(/&rpar;/g, ")")
    .replace(/&lcub;/g, "{")
    .replace(/&rcub;/g, "}")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Pull a double-quoted attribute value out of an opening-tag string.
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescapeAttr(m[1]) : null;
}

function numAttr(tag, name, fallback = 0) {
  const v = attr(tag, name);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---- tokenizer -------------------------------------------------------------
// We scan the string into a flat token stream of:
//   { kind: "open", tag, type }   <div ...> / <span ...> (not self-closed)
//   { kind: "selfclose", tag, type }  <img ... />
//   { kind: "close" }             </div> / </span>
//   { kind: "text", value }       raw text between tags
// then build a tree from it.

function tokenize(jsx) {
  const tokens = [];
  let i = 0;
  const n = jsx.length;
  while (i < n) {
    const lt = jsx.indexOf("<", i);
    if (lt === -1) {
      pushText(tokens, jsx.slice(i));
      break;
    }
    if (lt > i) pushText(tokens, jsx.slice(i, lt));
    const gt = jsx.indexOf(">", lt);
    if (gt === -1) break; // malformed; stop.
    const raw = jsx.slice(lt, gt + 1);
    if (raw.startsWith("</")) {
      tokens.push({ kind: "close" });
    } else if (raw.endsWith("/>")) {
      tokens.push({ kind: "selfclose", tag: raw, type: attr(raw, "data-node") });
    } else {
      tokens.push({ kind: "open", tag: raw, type: attr(raw, "data-node") });
    }
    i = gt + 1;
  }
  return tokens;
}

function pushText(tokens, s) {
  // Only meaningful (non-whitespace) text matters; toCode never puts text
  // between structural tags, only inside <span>.
  if (s && s.trim().length) tokens.push({ kind: "text", value: s });
}

// ---- style literal parsing -------------------------------------------------
// We mostly recover values from data-* attributes; style is parsed only as a
// fallback for fields that have no data-* (none here, but keep it available).
// Kept for completeness / future fields.

// ---- node construction -----------------------------------------------------

function parsePadding(L) {
  const p = L && L.padding ? L.padding : {};
  return {
    top: Number(p.top) || 0,
    right: Number(p.right) || 0,
    bottom: Number(p.bottom) || 0,
    left: Number(p.left) || 0,
  };
}

function styleColor(tag, key, fallback) {
  // style={{ ... key: "value" ... }} — recover a CSS value from the literal.
  const m = tag.match(new RegExp(`${key}: "([^"]*)"`));
  return m ? m[1] : fallback;
}

function styleNum(tag, key, fallback) {
  const m = tag.match(new RegExp(`${key}: "([^"]*)px"`));
  if (m) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

function styleOpacity(tag) {
  const m = tag.match(/opacity: ([0-9.]+)/);
  return m ? Number(m[1]) : 1;
}

function parseBorder(tag) {
  // border: "Npx solid color"
  const m = tag.match(/border: "(\d+(?:\.\d+)?)px solid ([^"]*)"/);
  if (m) return { strokeWidth: Number(m[1]), stroke: m[2] };
  return { strokeWidth: 0, stroke: "transparent" };
}

function buildNode(tag, type, textValue) {
  const node = {
    id: attr(tag, "data-node-id"),
    type,
    name: attr(tag, "data-name") ?? "",
    x: numAttr(tag, "data-x", 0),
    y: numAttr(tag, "data-y", 0),
    width: styleNum(tag, "width", 0),
    height: styleNum(tag, "height", 0),
    rotation: numAttr(tag, "data-rotation", 0),
    opacity: styleOpacity(tag),
    fill: styleColor(tag, "backgroundColor", "transparent"),
    zIndex: numAttr(tag, "data-z", 0),
  };
  const b = parseBorder(tag);
  node.stroke = b.stroke;
  node.strokeWidth = b.strokeWidth;

  if (type === "text") {
    node.fontSize = styleNum(tag, "fontSize", 16);
    node.color = styleColor(tag, "color", "#000000");
    node.text = textValue == null ? "" : unescapeText(textValue).trim();
  }
  if (type === "image") {
    node.src = attr(tag, "src") ?? "";
  }
  if (type === "instance") {
    // componentId comes from data-instance-of (the element NAME is cosmetic).
    node.componentId = attr(tag, "data-instance-of") ?? "";
    const ovRaw = attr(tag, "data-overrides");
    let overrides = {};
    if (ovRaw) {
      try {
        const parsed = JSON.parse(ovRaw);
        if (parsed && typeof parsed === "object") overrides = parsed;
      } catch {
        overrides = {};
      }
    }
    node.overrides = overrides;
  }
  if (type === "line") {
    node.x2 = numAttr(tag, "data-x2", 0);
    node.y2 = numAttr(tag, "data-y2", 0);
  }
  if (type === "frame" || type === "component") {
    node.clipsContent = attr(tag, "data-clips") !== "0";
  }
  if (CONTAINER.has(type)) {
    const layoutRaw = attr(tag, "data-layout");
    let L = { mode: "none" };
    if (layoutRaw) {
      try {
        L = JSON.parse(layoutRaw);
      } catch {
        L = { mode: "none" };
      }
    }
    if (L.mode && L.mode !== "none") {
      node.layout = {
        mode: L.mode,
        gap: Number(L.gap) || 0,
        padding: parsePadding(L),
        align: L.align || "start",
        justify: L.justify || "start",
      };
    } else {
      node.layout = { mode: "none" };
    }
    node.children = [];
  }
  return node;
}

// Walk a sibling list out of `tokens` starting at cursor.i, pushing built nodes
// into `into`, until the close that ends THIS list's parent (or stream end).
// `components` maps componentId -> parsed component node, used to splice a
// component master back in wherever its self-closing placement marker sits.
function parseSiblings(tokens, cursor, into, components) {
  while (cursor.i < tokens.length) {
    const tok = tokens[cursor.i];
    if (tok.kind === "close") {
      cursor.i += 1; // consume the close that ends THIS list's parent
      return;
    }
    if (tok.kind === "text") {
      cursor.i += 1; // stray text outside <span> — ignore
      continue;
    }
    if (tok.kind === "selfclose") {
      cursor.i += 1;
      if (tok.type === "component-placement") {
        // A component master sits here. We can't assume its definition has been
        // parsed yet (textual/tree order is not resolution order — a nested
        // component may be declared after its enclosing one), so we drop a
        // lightweight placeholder and resolve it in a separate splice pass once
        // EVERY component definition is known. This is order-independent.
        const id = attr(tok.tag, "data-node-id");
        into.push({ __placement: true, componentId: id });
        continue;
      }
      // <img .../> or <Comp_* data-node="instance" .../> — leaf, no close tag.
      into.push(buildNode(tok.tag, tok.type, null));
      continue;
    }
    if (tok.kind === "open") {
      const tag = tok.tag;
      const type = tok.type;
      cursor.i += 1;
      // Peek for an immediate text child (only <span> has one).
      let textValue = null;
      if (tokens[cursor.i] && tokens[cursor.i].kind === "text") {
        textValue = tokens[cursor.i].value;
        cursor.i += 1;
      }
      const node = buildNode(tag, type, textValue);
      if (CONTAINER.has(type)) {
        parseSiblings(tokens, cursor, node.children, components);
      } else {
        // Leaf element: consume its close tag.
        if (tokens[cursor.i] && tokens[cursor.i].kind === "close") cursor.i += 1;
      }
      into.push(node);
      continue;
    }
    cursor.i += 1;
  }
}

// Recursively replace every { __placement, componentId } placeholder with a
// fresh deep clone of the referenced component master from `components`. Done in
// a SECOND pass, after all component definitions are known, so resolution is
// independent of declaration/tree order (fixes the nested-component drop). A
// placement whose component is unknown is dropped (it had no definition to
// splice). `seen` guards against a component that (transitively) places itself.
function spliceList(list, components, seen) {
  const out = [];
  for (const node of list) {
    if (node && node.__placement) {
      const comp = components.get(node.componentId);
      if (comp) out.push(spliceNode(comp, components, seen));
      continue;
    }
    out.push(spliceNode(node, components, seen));
  }
  return out;
}

function spliceNode(node, components, seen) {
  if (!node || typeof node !== "object") return node;
  if (!Array.isArray(node.children)) return node;
  // Recursion guard for self-referential component placements.
  if (node.type === "component" && node.id != null) {
    if (seen.has(node.id)) {
      // Cap: stop expanding; emit the node with its placements left unresolved.
      const cloned = { ...node, children: [] };
      return cloned;
    }
    seen = new Set(seen);
    seen.add(node.id);
  }
  return { ...node, children: spliceList(node.children, components, seen) };
}

// Parse the body of each `function Comp_<safeId>() { return ( <div ...> ); }`
// declaration into a component node, keyed by its data-node-id (the real
// component id). Components may nest (a component body can hold a
// component-placement for another). We resolve in TWO order-independent phases:
//   Phase 1 — parse EVERY function body into a stub component, leaving any
//             nested component-placements as inert { __placement } markers.
//   Phase 2 — splice: deep-resolve those markers against the COMPLETE map.
// Because phase 1 commits every definition before any splicing happens, the
// result is correct regardless of the textual order of the declarations.
function parseComponentFunctions(jsx) {
  // Match `function Comp_X() {` ... capturing the body. toCode emits:
  //   function Name() {\n  return (\n<body>\n  );\n}\n
  // The body terminator is the literal `);}` / `); }` sentinel; esc() guarantees
  // span text can never forge it (parens/braces are entity-escaped), so this
  // non-greedy capture is safe.
  const re = /function\s+(Comp_[A-Za-z0-9_]*)\s*\(\)\s*\{\s*return\s*\(\s*([\s\S]*?)\s*\);\s*\}/g;
  const bodies = [];
  let m;
  while ((m = re.exec(jsx)) !== null) bodies.push(m[2]);

  // Phase 1: parse all bodies to stubs (placements stay as inert markers — we
  // pass no `components` map, so parseSiblings emits placeholders only).
  const stubs = new Map();
  for (const body of bodies) {
    const toks = tokenize(body);
    const cursor = { i: 0 };
    const out = [];
    parseSiblings(toks, cursor, out, null);
    const comp = out.find((n) => n && n.type === "component");
    if (comp && comp.id != null && !stubs.has(comp.id)) stubs.set(comp.id, comp);
  }

  // Phase 2: splice each committed component's subtree against the full map.
  const components = new Map();
  for (const [id, stub] of stubs) {
    components.set(id, spliceNode(stub, stubs, new Set()));
  }
  return components;
}

// Build the full design document from the token stream + parsed components.
function buildTree(tokens, components) {
  const rootIdx = tokens.findIndex((t) => t.kind === "open" && /data-doc="root"/.test(t.tag));
  if (rootIdx === -1) throw new Error("fromCode: root document element not found");
  const rootTag = tokens[rootIdx].tag;

  const doc = {
    version: Number(attr(rootTag, "data-doc-version")) || VERSION,
    document: {
      width: numAttr(rootTag, "data-doc-width", 1200),
      height: numAttr(rootTag, "data-doc-height", 800),
      background: attr(rootTag, "data-doc-background") || "#ffffff",
    },
    nodes: [],
  };

  const cursor = { i: rootIdx + 1 };
  const raw = [];
  parseSiblings(tokens, cursor, raw, components);
  // Resolve any top-level component-placement markers against the full map.
  doc.nodes = spliceList(raw, components, new Set());
  return doc;
}

/**
 * fromCode(jsxString) -> design document { version, document, nodes }.
 * Inverse of toCode(). See the module-level ASSUMPTION comment.
 */
export function fromCode(jsxString) {
  if (typeof jsxString !== "string") throw new Error("fromCode: expected a string");
  // First parse the standalone component function declarations, then walk the
  // Design tree splicing each component master in where its placement sits.
  const components = parseComponentFunctions(jsxString);
  const tokens = tokenize(jsxString);
  return buildTree(tokens, components);
}
