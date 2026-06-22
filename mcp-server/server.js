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
  createNode,
  updateNode,
  deleteNode,
  toSVG,
} from "./store.js";

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
        type: { type: "string", enum: ["rect", "ellipse", "text", "line", "frame", "group"], description: "Shape type or container" },
        name: { type: "string", description: "Optional layer name" },
        parentId: { type: "string", description: "Optional id of a frame/group to nest this node inside; coords become relative to that parent" },
        clipsContent: { type: "boolean", description: "For type=frame: clip children to frame bounds (default true)" },
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
    description: "Export the current design. format='json' returns the document; format='svg' returns a rendered SVG string.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["json", "svg"], default: "json" } },
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
        return ok(format === "svg" ? toSVG() : loadDesign());
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
