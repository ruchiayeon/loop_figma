// client-snippet.js — browser-side live-reload glue for the canvas.
// Plain JS, no build step. To be pasted into canvas/index.html later, e.g.:
//
//   <script src="/realtime/client-snippet.js"></script>
//   <script>connectSync(() => location.reload());</script>
//
// or with a finer-grained handler that re-fetches design.json:
//
//   connectSync(async () => {
//     const doc = await (await fetch("/design.json", { cache: "no-store" })).json();
//     renderDesign(doc);
//   });
//
// It opens a WebSocket to the sync hub and invokes onChange() whenever a
// {type:'design-changed'} message arrives. It auto-reconnects with backoff so a
// server restart (very common in the edit loop) heals on its own.

(function (global) {
  // Open a realtime connection to the sync hub.
  //   connectSync(onChange, opts?) → { close() }
  // opts.url   — explicit ws:// URL (default: same host, port from opts.port).
  // opts.port  — hub port when on the same host as the page (default 8081).
  function connectSync(onChange, opts) {
    opts = opts || {};
    var port = opts.port || 8081;
    var url =
      opts.url ||
      (location.protocol === "https:" ? "wss://" : "ws://") +
        location.hostname +
        ":" +
        port;

    var ws = null;
    var closed = false;
    var backoff = 500; // ms, grows to a cap on repeated failures.

    function open() {
      if (closed) return;
      ws = new WebSocket(url);

      ws.onopen = function () {
        backoff = 500; // reset once we're connected again.
      };

      ws.onmessage = function (ev) {
        var msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          return; // ignore non-JSON frames.
        }
        if (msg && msg.type === "design-changed") {
          try {
            onChange(msg);
          } catch (e) {
            /* swallow handler errors so the socket keeps living */
          }
        }
      };

      ws.onclose = function () {
        if (closed) return;
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };

      ws.onerror = function () {
        // onclose fires after onerror; reconnect is handled there.
        try {
          ws.close();
        } catch (e) {}
      };
    }

    open();

    return {
      close: function () {
        closed = true;
        if (ws) {
          try {
            ws.close();
          } catch (e) {}
        }
      },
    };
  }

  // Expose for both module and plain-script usage.
  global.connectSync = connectSync;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { connectSync };
  }
})(typeof window !== "undefined" ? window : this);
