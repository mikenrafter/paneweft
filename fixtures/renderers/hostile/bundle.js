// A renderer that TRIES everything the sandbox and CSP are supposed to forbid. The counter origin (a second server owned by the test)
// records any request that gets through. Results are kept on window.__probes for the test to read through the browser's own protocol.
(function () {
  var results = {};
  window.__probes = results;
  var counter = "";
  function done(name, outcome) { results[name] = outcome; }
  var tries = {
    "fetch-cross-origin": function () { return fetch(counter + "/hit?fetch").then(function () { return "ALLOWED"; }, function () { return "blocked"; }); },
    "fetch-same-origin-api": function () { return fetch("/api/index").then(function (r) { return r.status === 200 ? "ALLOWED" : "blocked"; }, function () { return "blocked"; }); },
    "websocket": function () { return new Promise(function (resolve) { try { var w = new WebSocket(counter.replace("http", "ws") + "/ws"); w.onopen = function () { resolve("ALLOWED"); }; w.onerror = function () { resolve("blocked"); }; w.onclose = function () { resolve("blocked"); }; } catch (e) { resolve("blocked"); } }); },
    "image": function () { return new Promise(function (resolve) { var i = new Image(); i.onload = function () { resolve("ALLOWED"); }; i.onerror = function () { resolve("blocked"); }; i.src = counter + "/pixel.png"; }); },
    "parent-document": function () { try { return Promise.resolve(parent.document.title ? "ALLOWED" : "ALLOWED-EMPTY"); } catch (e) { return Promise.resolve("blocked"); } },
    "top-navigation": function () { try { top.location.href = counter + "/nav"; return new Promise(function (r) { setTimeout(function () { r("requested"); }, 300); }); } catch (e) { return Promise.resolve("blocked"); } },
    "form-submit": function () { try { var f = document.createElement("form"); f.action = counter + "/form"; f.method = "post"; document.body.appendChild(f); f.submit(); return new Promise(function (r) { setTimeout(function () { r("requested"); }, 300); }); } catch (e) { return Promise.resolve("blocked"); } },
    "local-storage": function () { try { localStorage.setItem("x", "1"); return Promise.resolve("ALLOWED"); } catch (e) { return Promise.resolve("blocked"); } },
    "cookie": function () { try { document.cookie = "x=1"; return Promise.resolve(document.cookie === "x=1" ? "ALLOWED" : "blocked"); } catch (e) { return Promise.resolve("blocked"); } },
    "eval": function () { try { eval("1+1"); return Promise.resolve("ALLOWED"); } catch (e) { return Promise.resolve("blocked"); } },
    "inline-script": function () { window.__inline = false; var s = document.createElement("script"); s.textContent = "window.__inline = true"; document.head.appendChild(s); return Promise.resolve(window.__inline ? "ALLOWED" : "blocked"); },
    "bearer-in-url": function () { return Promise.resolve(/token|bearer/i.test(location.href + document.referrer) ? "ALLOWED" : "blocked"); },
  };
  function run() {
    var pending = Object.keys(tries).map(function (name) { return tries[name]().then(function (outcome) { done(name, outcome); }); });
    Promise.all(pending).then(function () { results.__finished = true; });
  }
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || m.type !== "bootstrap" || !event.ports[0]) return;
    var port = event.ports[0];
    port.onmessage = function (e) { if (e.data.type === "init") { counter = e.data.body.payload.counter; run(); } };
    port.postMessage({ protocol: 1, type: "ready", frameId: m.frameId, viewId: m.viewId, snapshotId: m.snapshotId, requestId: "r1", seq: 1, body: { nonce: m.nonce } });
  });
})();
