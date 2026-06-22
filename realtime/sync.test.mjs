// sync.test.mjs — GATE for the realtime sync hub.
// Run:  node realtime/sync.test.mjs
//
// Starts the hub on an ephemeral port, connects raw clients implemented with
// node:net + node:crypto (no `ws` dependency), and asserts that broadcast()
// delivers the EXACT JSON frame to one client and to two clients, then closes
// cleanly. Zero external dependencies.

import { connect } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { createSyncHub, watchDesign } from "./sync-server.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  passed += 1;
  console.log("  ok - " + msg);
}

// A minimal WebSocket client: performs the handshake, then resolves on the
// first text frame it receives, parsing an UNMASKED server frame.
function rawClient(port) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const expectAccept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");

    const sock = connect(port, "127.0.0.1");
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let onText = null; // set by the returned helper

    const api = {
      sock,
      // Resolve with the next decoded text-frame string.
      next() {
        return new Promise((res) => {
          onText = res;
          drain();
        });
      },
      close() {
        return new Promise((res) => {
          let done = false;
          const finish = () => { if (!done) { done = true; res(); } };
          sock.on("close", finish);
          sock.end();
          // Fallback in case the peer is already gone and no 'close' fires.
          setTimeout(() => { try { sock.destroy(); } catch {} finish(); }, 200);
        });
      },
    };

    function drain() {
      // Parse as many complete unmasked frames as are buffered.
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return; // wait for more bytes
        let payload = buf.slice(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = buf.slice(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.slice(offset + maskLen + len);
        if (opcode === 0x1 && onText) {
          api.lastMasked = masked;
          const cb = onText;
          onText = null;
          cb(payload.toString("utf8"));
        }
      }
    }

    sock.on("data", (chunk) => {
      if (!handshakeDone) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString("utf8");
        if (!/101 Switching Protocols/i.test(head)) {
          reject(new Error("bad handshake status:\n" + head));
          return;
        }
        const m = /sec-websocket-accept:\s*(.+)\r?$/im.exec(head);
        if (!m || m[1].trim() !== expectAccept) {
          reject(new Error("bad Sec-WebSocket-Accept"));
          return;
        }
        handshakeDone = true;
        buf = buf.slice(idx + 4); // leftover bytes are frame data
        resolve(api);
        drain();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      drain();
    });

    sock.on("error", reject);

    // Send the client handshake request.
    sock.write(
      [
        "GET / HTTP/1.1",
        "Host: 127.0.0.1:" + port,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: " + key,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n")
    );
  });
}

async function main() {
  console.log("realtime sync hub gate");

  const hub = createSyncHub({ port: 0 });
  await hub.ready;
  assert(typeof hub.port === "number" && hub.port > 0, "hub listens on ephemeral port " + hub.port);

  // --- single client receives the exact JSON frame ---
  const c1 = await rawClient(hub.port);
  assert(hub.clients.size === 1, "hub registered the connected client");

  const payload = { type: "design-changed", n: 42, s: "héllo" };
  const got1 = c1.next();
  hub.broadcast(payload);
  const text1 = await got1;
  assert(c1.lastMasked === false, "server frame is unmasked (RFC6455 server→client)");
  assert(text1 === JSON.stringify(payload), "client received exact JSON frame: " + text1);
  assert(JSON.parse(text1).type === "design-changed", "parsed payload has type design-changed");

  // --- two clients both receive the same broadcast ---
  const c2 = await rawClient(hub.port);
  assert(hub.clients.size === 2, "hub registered the second client");

  const msg2 = { type: "design-changed" };
  const a = c1.next();
  const b = c2.next();
  hub.broadcast(msg2);
  const [ta, tb] = await Promise.all([a, b]);
  assert(ta === JSON.stringify(msg2), "client 1 received broadcast to all");
  assert(tb === JSON.stringify(msg2), "client 2 received broadcast to all");

  // --- watchDesign export exists and is wired without throwing ---
  assert(typeof watchDesign === "function", "watchDesign export is a function");

  // --- clean shutdown ---
  await c1.close();
  await c2.close();
  await hub.close();
  assert(hub.clients.size === 0, "all clients dropped after close");

  console.log("\nALL " + passed + " ASSERTIONS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
