// Repo-owned renderer (classic script, no modules, spec N3). A small diagram: original index -> container ID -> backup name.
// Selecting the card (click or Enter/Space) asks the host to open the captured record in another pane.
(function () {
  var port = null, ctx = null, seq = 0;
  function send(type, body) { seq += 1; port.postMessage({ protocol: 1, type: type, frameId: ctx.frameId, viewId: ctx.viewId, snapshotId: ctx.snapshotId, requestId: "r" + seq, seq: seq, body: body || {} }); }
  function box(x, label, value, id) {
    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("tabindex", "0"); g.setAttribute("role", "button"); g.setAttribute("data-pw", "card-item"); g.setAttribute("data-id", id);
    g.setAttribute("aria-label", label + ": " + value);
    g.innerHTML = '<rect x="' + x + '" y="10" width="150" height="54" rx="6" fill="none" stroke="currentColor"/><text x="' + (x + 8) + '" y="30" font-size="11">' + label + '</text><text x="' + (x + 8) + '" y="50" font-size="14">' + String(value).replace(/[<&]/g, "") + "</text>";
    function open() { send("select_item", { itemId: id }); send("open_object", { object: ctx.objects[0] }); }
    g.addEventListener("click", open);
    g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return g;
  }
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || m.type !== "bootstrap" || !event.ports[0]) return;
    port = event.ports[0];
    ctx = { nonce: m.nonce, frameId: m.frameId, viewId: m.viewId, snapshotId: m.snapshotId, objects: [] };
    port.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === "init") {
        ctx.objects = msg.body.objects || [];
        var p = msg.body.payload, svg = document.getElementById("card");
        svg.appendChild(box(10, "original index", p.originalIndex, "index"));
        svg.appendChild(box(190, "container ID", p.containerId, "container"));
        svg.appendChild(box(370, "backup name", p.backupName, "backup"));
        send("resize", { height: 80 });
      }
    };
    send("ready", { nonce: ctx.nonce });
  });
})();
