# Mini-Figma — a local design tool with an agent bridge

A small but real Figma-style design tool: a tree-based document model, a browser
canvas, an MCP server so an agent can drive the design programmatically, a
**bidirectional code ↔ design bridge**, and **live reload**. The canvas and the
agent share one document (`design.json`), so human edits and agent edits land in
the same place — and now changes broadcast to every open canvas automatically.

This was built end-to-end by autonomous agent loops (build → adversarial review →
test gate → fix), which is why every layer ships with a machine-checkable gate.

## What's inside

```
mini-figma/
├── design.json              # the shared document (canvas + MCP both use it)
├── serve.js                 # static server + realtime sync hub (zero deps)
├── canvas/
│   └── index.html           # tree-aware React canvas (single file, no build)
├── mcp-server/
│   ├── server.js            # MCP server over stdio (11 tools, zero deps)
│   ├── store.js             # tree model + node ops + instance resolution + SVG renderer
│   ├── layout.js            # pure auto-layout engine  (layout(node) → positioned)
│   ├── seed.mjs             # writes a sample composition (frames + auto-layout + component)
│   ├── test.js              # MCP + store gate (107 checks)
│   └── layout.test.mjs      # auto-layout unit gate (25 checks)
├── bridge/
│   ├── to-code.mjs          # design → JSX (toCode)
│   ├── from-code.mjs        # JSX → design (fromCode)
│   └── roundtrip.test.mjs   # invertibility gate (20 checks)
├── realtime/
│   ├── sync-server.mjs      # RFC6455 WebSocket hub, Node built-ins only
│   ├── client-snippet.js    # browser connectSync() (inlined into the canvas)
│   └── sync.test.mjs        # broadcast gate (10 checks)
└── e2e.test.mjs             # end-to-end gate: model → svg → code → round-trip (10 checks)
```

## The document model

A design is a **tree**. Every node may have `children`; a child's `x`/`y` are
relative to its parent's origin (top-level nodes are relative to the canvas, so
old flat documents keep working).

Node types:

| Type        | What it is                                                        |
|-------------|-------------------------------------------------------------------|
| `frame`     | Container with a background + optional clipping (`clipsContent`)   |
| `group`     | Container with no background (a transform wrapper)                 |
| `rect` `ellipse` `text` `line` `image` | Leaf shapes                            |
| `component` | A **master** definition — a reusable frame-like subtree           |
| `instance`  | A **use** of a component (`componentId` + per-child `overrides`)   |

**Auto-layout.** A `frame`/`group` can carry a `layout` config
(`mode: horizontal|vertical`, `gap`, `padding`, `align`, `justify`). Auto-layout
is a single pure function (`layout.js`) and is **resolved into stored
coordinates** on every mutation — so both renderers (the canvas and `toSVG`) only
ever draw the coordinates in the document. No two layout engines to drift apart.

**Components & instances.** A `component` is the master; an `instance` references
it and may override any master child's props (matched by master child id).
`resolveInstances()` expands each instance into a positioned clone of the master
with overrides applied (recursion-capped). This is the same idea as code
components: define once, reuse with props.

## The canvas

Open `canvas/index.html` in a browser. You get tools (select / rect / ellipse /
text / line / frame / group), move + resize, a properties panel, a **nested
layers tree** (with component ◆ / instance ◇ badges), zoom/pan, export to
JSON/PNG, and **live reload** — when the document changes, the canvas refetches
automatically (see below).

Run it through the server so live reload and `Load design.json` work:

```bash
cd mini-figma
node serve.js            # serves the canvas AND starts the realtime hub
# → http://localhost:8080/canvas/   (live sync on ws://localhost:8081)
```

## Realtime live reload

`serve.js` mounts a dependency-free WebSocket hub and watches `design.json`. When
an agent (or the seed script) writes the document, the hub broadcasts
`design-changed` and every open canvas refetches — no Load button needed. The
canvas shows a `● live` indicator and degrades gracefully if the hub isn't up.

## The MCP server

Zero dependencies — Node 18+, no `npm install`.

```bash
cd mini-figma/mcp-server
node server.js        # speaks MCP over stdio
```

### Tools exposed (11)

| Tool             | What it does                                              |
|------------------|----------------------------------------------------------|
| `get_design`     | Read the whole document (tree + every node)              |
| `create_node`    | Add any node type (supports `parentId`, `layout`, `src`) |
| `update_node`    | Change properties of a node by id (at any depth)         |
| `delete_node`    | Remove a node (and its subtree); reflows auto-layout     |
| `move_node`      | Reparent / reorder a node (cycle-checked)                |
| `set_layout`     | Set a container's auto-layout and re-resolve coords      |
| `create_component` | Create a reusable component master                     |
| `create_instance`  | Place an instance of a component                       |
| `set_override`     | Override a master child's props on one instance        |
| `export_design`  | Serialize as `json`, `svg`, or **`code`** (JSX)          |
| `import_code`    | Replace the document from JSX (the reverse bridge)       |

### Connect it to Claude Code

```bash
claude mcp add mini-figma -- node ABSOLUTE/PATH/TO/mini-figma/mcp-server/server.js
```

## The code ↔ design bridge

The headline feature: design **is** code and code **is** design.

- `export_design format=code` (or `bridge/toCode`) turns the document into a
  self-contained React component. Each design `component` becomes a named
  function component; each `instance` becomes `<Comp …/>`.
- `import_code` (or `bridge/fromCode`) parses that JSX back into a document.

They are two halves of one invertible mapping —
`normalize(fromCode(toCode(design))) === normalize(design)` — which is enforced
by the round-trip gate, so the visualization stays faithful in both directions.

## Tests (the quality gates)

```bash
cd mini-figma
node mcp-server/test.js          # MCP + store/tree/instances   (107)
node mcp-server/layout.test.mjs  # auto-layout geometry          (25)
node bridge/roundtrip.test.mjs   # code↔design invertibility     (20)
node realtime/sync.test.mjs      # websocket broadcast           (10)
node e2e.test.mjs                # full pipeline end-to-end       (10)
```

172 checks total. Each one goes red on the specific regression it guards — these
are the gates the build loops had to pass to advance.

## Try the sample

```bash
node mcp-server/seed.mjs   # nested frames + auto-layout row + Button component
```

Then open the canvas (it loads automatically with the server running).

## Honest limitations

- Single document, single user. The realtime hub does live reload, not
  conflict-free multiplayer editing.
- Vector support is a single `line` plus shapes — no pen/bezier path editing.
- `import_code` parses the bridge's own JSX subset, not arbitrary React.
- Auto-layout covers flex-style row/column; no grid or constraints.
