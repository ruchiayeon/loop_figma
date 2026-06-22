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

const CONTAINER = new Set(["frame", "group"]);

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
  if (type === "line") {
    node.x2 = numAttr(tag, "data-x2", 0);
    node.y2 = numAttr(tag, "data-y2", 0);
  }
  if (type === "frame") {
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

// Build a node tree from the token stream, starting just after the root open
// tag and stopping at the matching root close.
function buildTree(tokens) {
  // Find the root <div data-doc="root"> open tag.
  let rootIdx = tokens.findIndex((t) => t.kind === "open" && /data-doc="root"/.test(t.tag));
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

  // Walk children recursively. `pos` is a mutable cursor object.
  const cursor = { i: rootIdx + 1 };

  function parseChildren(into) {
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
        // <img ... /> — leaf, no children, no close tag.
        into.push(buildNode(tok.tag, tok.type, null));
        cursor.i += 1;
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
          // Recurse into element children; parseChildren consumes the close.
          parseChildren(node.children);
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

  parseChildren(doc.nodes);
  return doc;
}

/**
 * fromCode(jsxString) -> design document { version, document, nodes }.
 * Inverse of toCode(). See the module-level ASSUMPTION comment.
 */
export function fromCode(jsxString) {
  if (typeof jsxString !== "string") throw new Error("fromCode: expected a string");
  const tokens = tokenize(jsxString);
  return buildTree(tokens);
}
