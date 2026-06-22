# Mini-Figma — a design canvas with an MCP server

A small, real Figma-style design tool plus an MCP server that lets an agent
(Claude, Claude Code, or any MCP client) create and edit the design
programmatically. The canvas and the agent share one document — `design.json` —
so human edits and agent edits land in the same place.

This is **not** a full Figma clone (no realtime multiplayer, vector networks,
auto-layout, or plugin runtime). It's a focused MVP that demonstrates the core:
a working editor + agent control over MCP.

## What's inside

```
mini-figma/
├── design.json          # the shared document (canvas + MCP both use this)
├── canvas/
│   └── index.html       # the React design canvas (single file, opens in a browser)
└── mcp-server/
    ├── server.js        # MCP server (stdio, zero dependencies)
    ├── store.js         # data model + node operations + SVG renderer
    ├── test.js          # automated test suite (the quality gate)
    ├── seed.mjs         # writes a sample composition into design.json
    └── package.json
```

## The canvas

Open `canvas/index.html` in a browser (Chrome/Edge/Firefox). You get:

- Tools: Select, Rect, Ellipse, Text, Line — pick one and click the canvas to place a shape.
- Move (drag), resize (corner handles), and a properties panel (position, size, rotation, opacity, fill, stroke, text, font).
- Layers panel with select / delete / reorder (forward / back).
- Zoom (Ctrl/⌘ + scroll), pan (drag empty canvas).
- Export to JSON or PNG.
- **Load design.json** / **Open file** to pull in whatever the agent produced.

> To make the in-app **Load design.json** button work, open the canvas through a
> local server (so the browser can `fetch` the file):
>
> ```bash
> cd mini-figma
> python3 -m http.server 8080
> # then visit http://localhost:8080/canvas/
> ```
>
> Opening `index.html` directly with `file://` also works — just use the
> **Open file** button to pick `design.json` instead of **Load design.json**.

## The MCP server

Zero dependencies — runs on Node 18+ with no `npm install`.

```bash
cd mini-figma/mcp-server
node server.js        # speaks MCP over stdio
```

### Tools exposed

| Tool            | What it does                                              |
|-----------------|----------------------------------------------------------|
| `get_design`    | Read the whole document (canvas + every node)            |
| `create_node`   | Add a `rect` / `ellipse` / `text` / `line`               |
| `update_node`   | Change properties of a node by id                        |
| `delete_node`   | Remove a node by id                                       |
| `export_design` | Serialize as `json` or rendered `svg`                    |

### Connect it to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mini-figma": {
      "command": "node",
      "args": ["ABSOLUTE/PATH/TO/mini-figma/mcp-server/server.js"]
    }
  }
}
```

### Connect it to Claude Code

```bash
claude mcp add mini-figma -- node ABSOLUTE/PATH/TO/mini-figma/mcp-server/server.js
```

## How agent ↔ canvas works (the feedback loop)

1. An agent calls `create_node` / `update_node` over MCP. The server writes `design.json`.
2. You click **Load design.json** in the canvas and see the result.
3. You tweak by hand; **Export JSON** writes `design.json` back.
4. The agent calls `get_design` to read your changes and iterate.

So you can run a generate → review → refine loop: the agent proposes a design,
you (or an evaluator agent) critique it, and the agent revises — all over the
same shared document.

## Tests (the quality gate)

```bash
cd mini-figma/mcp-server
node test.js
```

Spawns the server as a real MCP subprocess, performs the JSON-RPC handshake, and
asserts all five tools behave correctly (currently 22 checks). Exits non-zero on
any failure — this is the gate the build loop had to pass.

## Try the sample

```bash
cd mini-figma/mcp-server
node seed.mjs         # writes a sample card composition into design.json
```

Then load it in the canvas.

## Honest limitations

- Single document, single user. No realtime collaboration.
- Shapes only (rect / ellipse / text / line). No paths, images, components, or auto-layout.
- Canvas ↔ server sync is manual (Load / Export buttons), not live. A websocket
  layer would make it live but was out of scope for the MVP.
