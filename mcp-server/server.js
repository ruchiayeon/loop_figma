#!/usr/bin/env node
// server.js — Mini-Figma MCP server (zero dependencies).
//
// Implements the Model Context Protocol over stdio: newline-delimited
// JSON-RPC 2.0 messages on stdin/stdout. Compatible with any MCP client
// (Claude Desktop, Claude Code, custom agents) that speaks the stdio
// transport. No npm packages required.
//
// Tools:
//   get_design     : read the whole document
//   create_node    : add a rect / ellipse / text / line
//   update_node    : change properties of an existing node
//   delete_node    : remove a node
//   export_design  : serialize the document as json or svg
//
// State persists to ../design.json, which the React canvas also reads, so
// agent edits and human edits share one document.

import readline from "node:readline";
import {
  loadDesign,
  saveDesign,
  createNode,
  updateNode,
  deleteNode,
  moveNode,
  findNode,
  toSVG,
  setOverride,
} from "./store.js";
import { toCode } from "../bridge/to-code.mjs";
import { fromCode } from "../bridge/from-code.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "mini-figma", version: "1.0.0" };

const TOOLS = [
  {
    name: "get_design",
    description:
      "Read the full design document: canvas size, background, and every node with its properties. Call this first to see what exists before editing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_node",
    description: "Create a new node on the canvas. Returns the created node including its generated id.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["rect", "ellipse", "text", "line", "frame", "group", "image"], description: "Shape type, container, or image" },
        name: { type: "string", description: "Optional layer name" },
        parentId: { type: "string", description: "Optional id of a frame/group to nest this node inside; coords become relative to that parent" },
        clipsContent: { type: "boolean", description: "For type=frame: clip children to frame bounds (default true)" },
        layout: {
          type: "object",
          description: "For type=frame/group: auto-layout config. Children x/y are resolved by the engine.",
          properties: {
            mode: { type: "string", enum: ["none", "horizontal", "vertical"] },
            gap: { type: "number" },
            padding: {
              type: "object",
              properties: { top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" }, left: { type: "number" } },
            },
            align: { type: "string", enum: ["start", "center", "end"] },
            justify: { type: "string", enum: ["start", "center", "end", "space-between"] },
          },
        },
        x: { type: "number" }, y: { type: "number" },
        width: { type: "number" }, height: { type: "number" },
        rotation: { type: "number", description: "Degrees" },
        opacity: { type: "number", description: "0..1" },
        fill: { type: "string", description: "CSS color or 'transparent'" },
        stroke: { type: "string" }, strokeWidth: { type: "number" },
        text: { type: "string", description: "For type=text" },
        fontSize: { type: "number", description: "For type=text" },
        color: { type: "string", description: "Text color, for type=text" },
        x2: { type: "number", description: "Line end x, for type=line" },
        y2: { type: "number", description: "Line end y, for type=line" },
        src: { type: "string", description: "Image URL/data URI, for type=image" },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  {
    name: "update_node",
    description: "Update properties of an existing node by id. Only the fields you pass are changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        x: { type: "number" }, y: { type: "number" },
        width: { type: "number" }, height: { type: "number" },
        rotation: { type: "number" }, opacity: { type: "number" },
        fill: { type: "string" }, stroke: { type: "string" }, strokeWidth: { type: "number" },
        zIndex: { type: "number" },
        text: { type: "string" }, fontSize: { type: "number" }, color: { type: "string" },
        x2: { type: "number" }, y2: { type: "number" },
        src: { type: "string", description: "For type=image" },
        layout: { type: "object", description: "For type=frame/group: auto-layout config; triggers re-resolve" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_node",
    description: "Delete a node from the canvas by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "export_design",
    description: "Export the current design. format='json' returns the document; format='svg' returns a rendered SVG string; format='code' returns a self-contained React/JSX component (with data-node markers).",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["json", "svg", "code"], default: "json" } },
      additionalProperties: false,
    },
  },
  {
    name: "move_node",
    description: "Reparent or reorder a node. parentId=null (or omitted) moves it to the top level; index sets its position among its new siblings. Re-resolves auto-layout. Returns the moved node.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        parentId: { type: ["string", "null"], description: "Destination frame/group id, or null for top level" },
        index: { type: "number", description: "Insertion index among the destination siblings (defaults to end)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_layout",
    description: "Set a frame/group's auto-layout config and immediately re-resolve children coordinates. Returns the updated subtree (with resolved child x/y).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["none", "horizontal", "vertical"] },
        gap: { type: "number" },
        padding: {
          type: "object",
          properties: { top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" }, left: { type: "number" } },
        },
        align: { type: "string", enum: ["start", "center", "end"] },
        justify: { type: "string", enum: ["start", "center", "end", "space-between"] },
      },
      required: ["id", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "import_code",
    description: "Replace the entire design document with one parsed from a JSX string (the inverse of export_design format='code'). Returns the new document.",
    inputSchema: {
      type: "object",
      properties: { jsx: { type: "string", description: "JSX produced by export_design format='code'" } },
      required: ["jsx"],
      additionalProperties: false,
    },
  },
  {
    name: "create_component",
    description: "Create a reusable component MASTER (a frame-like container). Add children to it (parentId=<component id>), then place copies with create_instance. Returns the created component node.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional layer name" },
        parentId: { type: "string", description: "Optional id of a frame/group/component to nest this master inside" },
        clipsContent: { type: "boolean", description: "Clip children to the master's bounds (default true)" },
        layout: {
          type: "object",
          description: "Auto-layout config for the master's children (resolved by the engine).",
          properties: {
            mode: { type: "string", enum: ["none", "horizontal", "vertical"] },
            gap: { type: "number" },
            padding: {
              type: "object",
              properties: { top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" }, left: { type: "number" } },
            },
            align: { type: "string", enum: ["start", "center", "end"] },
            justify: { type: "string", enum: ["start", "center", "end", "space-between"] },
          },
        },
        x: { type: "number" }, y: { type: "number" },
        width: { type: "number" }, height: { type: "number" },
        rotation: { type: "number" }, opacity: { type: "number" },
        fill: { type: "string" }, stroke: { type: "string" }, strokeWidth: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_instance",
    description: "Place an INSTANCE (a use) of a component master. Renders as a group at x,y containing the master's content, with per-master-child overrides applied. Returns the created instance node.",
    inputSchema: {
      type: "object",
      properties: {
        componentId: { type: "string", description: "id of the component master to instantiate" },
        parentId: { type: "string", description: "Optional id of a frame/group/component to nest this instance inside" },
        x: { type: "number" }, y: { type: "number" },
        name: { type: "string" },
        overrides: {
          type: "object",
          description: "Map of MASTER CHILD id -> partial props patch, e.g. { \"<masterChildId>\": { \"text\": \"Buy now\", \"fill\": \"#16a34a\" } }",
          additionalProperties: true,
        },
      },
      required: ["componentId"],
      additionalProperties: false,
    },
  },
  {
    name: "set_override",
    description: "Set/merge an override patch for one master child on one instance. Only the props you pass change; other overrides are preserved. Returns the updated instance node.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        masterChildId: { type: "string", description: "id of the MASTER child to override" },
        props: { type: "object", description: "Partial props patch (e.g. { text, fill, ... })", additionalProperties: true },
      },
      required: ["instanceId", "masterChildId", "props"],
      additionalProperties: false,
    },
  },
];

function ok(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }] };
}
function fail(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function callTool(name, args = {}) {
  try {
    switch (name) {
      case "get_design":
        return ok(loadDesign());
      case "create_node":
        return ok(createNode(args));
      case "update_node": {
        const { id, ...props } = args;
        return ok(updateNode(id, props));
      }
      case "delete_node":
        return ok(deleteNode(args.id));
      case "export_design": {
        const format = args.format || "json";
        if (format === "svg") return ok(toSVG());
        if (format === "code") return ok(toCode(loadDesign()));
        return ok(loadDesign());
      }
      case "move_node": {
        const { id, parentId = null, index } = args;
        return ok(moveNode(id, parentId, index));
      }
      case "set_layout": {
        const { id, mode, gap, padding, align, justify } = args;
        // Build a layout config from only the provided fields, then re-resolve.
        const found = findNode(id);
        if (!found) throw new Error(`Node "${id}" not found`);
        const layout = { mode };
        if (gap !== undefined) layout.gap = gap;
        if (padding !== undefined) layout.padding = padding;
        if (align !== undefined) layout.align = align;
        if (justify !== undefined) layout.justify = justify;
        // updateNode persists layout AND calls applyLayout, returning the
        // resolved node — exactly the updated subtree with recomputed child x/y.
        return ok(updateNode(id, { layout }));
      }
      case "import_code": {
        // Parse the JSX and REPLACE the whole document, then save. fromCode's
        // coords already round-trip (data-x/data-y), so the imported doc is a
        // faithful inverse of export_design format='code' — no re-resolve here.
        const doc = fromCode(args.jsx);
        saveDesign(doc);
        return ok(doc);
      }
      case "create_component":
        // Sugar over create_node with type=component.
        return ok(createNode({ ...args, type: "component" }));
      case "create_instance":
        // Sugar over create_node with type=instance.
        return ok(createNode({ ...args, type: "instance" }));
      case "set_override": {
        const { instanceId, masterChildId, props } = args;
        return ok(setOverride(instanceId, masterChildId, props));
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err.message);
  }
}

// ---- JSON-RPC plumbing ----

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) require no response.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // ack only
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const result = callTool(params?.name, params?.arguments || {});
      reply(id, result);
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore malformed lines
  }
  try {
    handle(msg);
  } catch (err) {
    if (msg && msg.id != null) replyError(msg.id, -32603, err.message);
  }
});

console.error("[mini-figma] MCP server running on stdio");
