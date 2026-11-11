// Sends forged and malformed messages after a correct handshake, then reloads itself. The host must reject each message visibly,
// open no pane for any of them, and revoke the port on the unexpected reload (spec section 5).
(function () {
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || m.type !== "bootstrap" || !event.ports[0]) return;
    var port = event.ports[0], seq = 0;
    function base(over) { seq += 1; var b = { protocol: 1, type: "ready", frameId: m.frameId, viewId: m.viewId, snapshotId: m.snapshotId, requestId: "r" + seq, seq: seq, body: {} }; for (var k in over) b[k] = over[k]; return b; }
    port.postMessage(base({ type: "ready", body: { nonce: m.nonce } }));
    port.postMessage(base({ type: "open_object", seq: 2, body: { object: "o99" } }));            // not permitted for this view
    port.postMessage(base({ type: "open_object", seq: 3, snapshotId: "snap-FOREIGN", body: { object: "o1" } })); // wrong snapshot
    port.postMessage(base({ type: "open_object", seq: 4, frameId: "frame-FOREIGN", body: { object: "o1" } }));   // wrong frame
    port.postMessage(base({ type: "fetch", seq: 5, body: { url: "http://127.0.0.1/" } }));                      // no such message type
    port.postMessage(base({ type: "open_object", seq: 6, protocol: 2, body: { object: "o1" } }));               // wrong protocol version
    port.postMessage(base({ type: "render_error", seq: 7, body: { message: "x".repeat(70000) } }));             // over 64 KiB
    port.postMessage(base({ type: "open_object", seq: 2, body: { object: "o1" } }));                           // sequence goes backwards
    setTimeout(function () { port.postMessage(base({ type: "render_error", seq: 8, body: { message: "about to reload" } })); location.reload(); }, 200);
  });
})();
