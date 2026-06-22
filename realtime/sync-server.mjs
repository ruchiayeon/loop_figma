// sync-server.mjs — tiny realtime broadcast hub, Node built-ins ONLY.
// Implements the RFC6455 WebSocket handshake + a minimal frame writer over
// node:http + node:crypto, so there is NO npm dependency (no `ws` package).
//
// This is the live-reload backbone: serve.js can mount the hub and call
// watchDesign(hub, path) so every browser canvas reloads when design.json
// changes. The hub itself is generic — broadcast(msg) ships a JSON text frame
// to every connected client.
//
// Design notes / RFC6455 essentials:
//   - Handshake: sha1(Sec-WebSocket-Key + GUID) base64 → Sec-WebSocket-Accept.
//   - Server→client frames are UNMASKED (mask bit 0). Client→server frames are
//     masked; we don't need to read them for broadcast, but we still drain the
//     socket and handle close frames so connections clean up.

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { watch } from "node:fs";

// Fixed RFC6455 magic GUID used to derive the accept key.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(secWebSocketKey) {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

// Encode a string as a single unmasked text frame (FIN + opcode 0x1).
function encodeTextFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    // 64-bit big-endian length; high 32 bits are 0 for any realistic message.
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

// A server-side close frame (opcode 0x8), unmasked, empty payload.
const CLOSE_FRAME = Buffer.from([0x88, 0x00]);

// Create a realtime broadcast hub.
//   createSyncHub({ port }) → { server, port, broadcast, clients, close }
// Pass port:0 for an ephemeral port; read the assigned port from the returned
// object's `port` (populated synchronously is not guaranteed — see `ready`).
export function createSyncHub({ port = 0 } = {}) {
  const clients = new Set();

  const server = createServer((req, res) => {
    // Non-upgrade HTTP requests get a tiny health response.
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required: this endpoint speaks WebSocket.\n");
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ].join("\r\n");
    socket.write(headers);

    clients.add(socket);
    socket.setNoDelay(true);

    const drop = () => {
      clients.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
    // We don't need to parse inbound client frames for broadcast, but we must
    // consume them so the socket doesn't back up. A client close frame (0x88)
    // triggers our own teardown.
    socket.on("data", (buf) => {
      if (buf.length && (buf[0] & 0x0f) === 0x8) {
        try { socket.write(CLOSE_FRAME); } catch {}
        socket.end();
      }
    });
  });

  // broadcast takes an OBJECT and serializes it; every connected client gets
  // one JSON text frame. Dead sockets are pruned defensively.
  function broadcast(message) {
    const frame = encodeTextFrame(JSON.stringify(message));
    for (const socket of clients) {
      if (socket.writable) {
        try { socket.write(frame); } catch { clients.delete(socket); }
      } else {
        clients.delete(socket);
      }
    }
  }

  function close() {
    return new Promise((resolve) => {
      for (const socket of clients) {
        try { socket.write(CLOSE_FRAME); socket.end(); } catch {}
        try { socket.destroy(); } catch {}
      }
      clients.clear();
      server.close(() => resolve());
    });
  }

  const hub = { server, port, broadcast, clients, close };

  // Begin listening; update the real port once assigned (matters for port:0).
  hub.ready = new Promise((resolve) => {
    server.listen(port, () => {
      hub.port = server.address().port;
      resolve(hub);
    });
  });

  return hub;
}

// Wire a hub to design.json change events. Watches the file with fs.watch and
// broadcasts {type:'design-changed'} (debounced, because fs.watch — especially
// on Windows — fires several events per save). Returns the FSWatcher so callers
// can stop it. Kept separate from broadcast() so the broadcast path has zero
// filesystem coupling.
export function watchDesign(hub, designPath, { debounceMs = 80 } = {}) {
  let timer = null;
  const watcher = watch(designPath, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      hub.broadcast({ type: "design-changed" });
    }, debounceMs);
  });
  watcher.on("error", () => { /* file briefly missing during rewrite — ignore */ });
  return watcher;
}
