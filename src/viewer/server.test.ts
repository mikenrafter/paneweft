// Viewer HTTP server over REAL session directories (docs/red-contract.md section 8, design section 5).
// Claims: MC15 (loopback only, session credential, foreign origins, no execution route, traversal, server.json),
// MC6 (/api/source numbering and currency), MC12 (a registered view shows up without a rebuild),
// MC20 (only manifest-registered, validated snapshots are served).
// Placement: co-located with the module (test-quality 2); the cross-process flows are in test/transport.e2e.test.ts.
// Expected values are literals from the contract or hand-derived from the committed fixtures; nothing is
// imported from src/ except the functions under test.
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeOperation } from "../core/operations.ts";
import { openSession } from "../core/session.ts";
import { startViewer } from "./server.ts";
import { allBundle, clone } from "../../test/helpers/fixtures.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { patch } from "../../test/helpers/patch.ts";
import { DIST_VIEWER, bearer, expectErrorBody, jsonOf, rawRequest, tcpProbe, treeFingerprint, useViewers } from "../../test/helpers/wire-http.ts";
import { wireJson, wirePath } from "../../test/helpers/wire-session.ts";

const viewers = useViewers();
const { makeTemp } = viewers;

const SEVEN_VIEW_IDS = ["cancellation-notebook", "check-source", "delivery-path", "layout", "modules", "vigil-one-write", "watch-shape"];
const WATCH_QUERY = "snapshot=snap-1&repository=r&id=watch&kind=vigil%2Fwatch";
const VIEW_QUERY = "viewId=modules&snapshotId=snap-1";

describe("viewer server: loopback binding", () => {
  // why: a viewer bound to a LAN or wildcard address would hand local code excerpts to the network (design 5
  //      "Bind loopback"). The server reports its own host, but a property proves nothing, so we also open a socket.
  // proves: CLAIM(MC15)
  it("[MC15] binds exactly 127.0.0.1: the property, the origin string and a real TCP connection agree", async () => {
    const { server } = await viewers.start();
    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0); // ephemeral port (options.port default 0); any positive port is valid
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    const probe = await tcpProbe("127.0.0.1", server.port);
    expect(probe).toEqual({ result: "connected", remoteAddress: "127.0.0.1" });
  });

  // why: 0.0.0.0 would still report host "127.0.0.1" if only the property were set. On Linux the whole 127.0.0.0/8
  //      block is loopback, so a socket bound to 127.0.0.1 refuses 127.0.0.2 while a wildcard socket accepts it:
  //      this assertion is unconditional on Linux and kills a wildcard bind with no external interface needed.
  // proves: CLAIM(MC15)
  it("[MC15] refuses connections to 127.0.0.2 on the same port (not a wildcard bind)", async () => {
    const { server } = await viewers.start();
    const control = await tcpProbe("127.0.0.1", server.port);
    expect(control.result, "positive control: the probe must connect to the real address").toBe("connected");
    const other = await tcpProbe("127.0.0.2", server.port);
    expect(other).toEqual({ result: "failed", code: "ECONNREFUSED" });
  });

  // why: second layer of the wildcard check on the machine's real interfaces. NOTE: this loop is vacuous on a host
  //      without any external IPv4 interface; the unconditional checks are the 127.0.0.2 test above and the control here.
  // proves: CLAIM(MC15)
  it("[MC15] refuses connections on every external IPv4 interface address of this host", async () => {
    const { server } = await viewers.start();
    const control = await tcpProbe("127.0.0.1", server.port);
    expect(control.result).toBe("connected");
    const external = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    const outcomes: Record<string, unknown> = {};
    for (const address of external) outcomes[address] = (await tcpProbe(address, server.port)).result;
    expect(Object.values(outcomes).every((value) => value === "failed"), JSON.stringify(outcomes)).toBe(true);
  });

  // why: the host option is the only way to widen the bind; every non-loopback spelling must be refused BEFORE a
  //      socket exists (red-contract 8: only 127.0.0.1 or ::1). Control: the explicit loopback host starts.
  // proves: CLAIM(MC15)
  describe.each(["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com"])("host %s", (host) => {
    it("[MC15] startViewer refuses it with NON_LOOPBACK_HOST and writes no server.json", async () => {
      const { session, dir } = await viewers.session();
      const error = mustFail(await startViewer({ session, host, assetsDirectory: DIST_VIEWER }), `startViewer(${host})`);
      expect(error.code).toBe("NON_LOOPBACK_HOST");
      expect(existsSync(join(dir, "server.json"))).toBe(false);
    });
  });
  it("[MC15] control: the explicit host 127.0.0.1 is accepted", async () => {
    const { server } = await viewers.start({}, { host: "127.0.0.1" });
    expect(server.host).toBe("127.0.0.1");
  });
});

describe("viewer server: session credential", () => {
  // why: an unguessable credential is the only barrier against another local process or a web page that can reach
  //      the port (design 5 "unguessable session credential"). >= 128 bits means >= 32 hex or >= 22 base64url chars.
  // proves: CLAIM(MC15)
  it("[MC15] the token has at least 128 bits in hex or base64url form", async () => {
    const { server } = await viewers.start();
    const hex = /^[0-9a-f]{32,}$/.test(server.token);
    const base64url = /^[A-Za-z0-9_-]{22,}$/.test(server.token);
    expect(hex || base64url, `token ${JSON.stringify(server.token)} must be hex (>=32) or base64url (>=22)`).toBe(true);
  });

  // why: a constant or per-process-constant token is guessable by anyone who saw one run (red-contract 8: unique per instance).
  // proves: CLAIM(MC15)
  it("[MC15] two servers have different tokens; a restarted server on the same session gets a new one", async () => {
    const first = await viewers.start();
    const second = await viewers.start();
    expect(first.server.token).not.toBe(second.server.token);
    const firstToken = first.server.token;
    await first.server.close();
    const restarted = viewers.track(must(await startViewer({ session: first.session, assetsDirectory: DIST_VIEWER }), "restart"));
    expect(restarted.token).not.toBe(firstToken);
  });

  // why: the token must travel in the URL FRAGMENT only: fragments are never sent to the server, written to access
  //      logs or put in Referer headers; a query-string token would leak all three (red-contract 8).
  // proves: CLAIM(MC15)
  it("[MC15] urlFor puts the token only in the fragment, with view and snapshot appended after it", async () => {
    const { server } = await viewers.start();
    const bare = server.urlFor();
    expect(bare).toBe(`${server.origin}/#token=${server.token}`);
    const keyed = server.urlFor({ viewId: "modules", snapshotId: "snap-1" });
    expect(keyed).toBe(`${server.origin}/#token=${server.token}&view=modules&snapshot=snap-1`);
    for (const url of [bare, keyed]) {
      const parsed = new URL(url);
      expect(parsed.search).toBe("");
      expect(parsed.pathname).toBe("/");
      expect(url.split("#")[0]).not.toContain(server.token);
    }
  });
});

describe("viewer server: /api authentication", () => {
  const apiRoutes = [
    "/api/index",
    "/api/registry",
    "/api/search?q=cancel",
    `/api/view?${VIEW_QUERY}`,
    `/api/entity?${WATCH_QUERY}`,
    "/api/source?viewId=check-source&snapshotId=snap-1&itemId=a",
  ];

  // why: every API route needs the bearer token (red-contract 8). The route list is pinned by name so that
  //      emptying it cannot pass vacuously; the positive control proves each route works WITH the token.
  // proves: CLAIM(MC15)
  describe.each(apiRoutes)("route %s", (route) => {
    it("[MC15] answers 401 UNAUTHORIZED (paneweft.error/1) without Authorization, and not-401 with the token", async () => {
      const { server } = await viewers.start();
      const denied = await rawRequest(server, route);
      expectErrorBody(denied, 401, "UNAUTHORIZED");
      const allowed = await rawRequest(server, route, { headers: bearer(server.token) });
      expect(allowed.status, `with token: ${allowed.text.slice(0, 200)}`).not.toBe(401);
      expect(allowed.status).toBeLessThan(500);
    });
  });

  // why: a prefix-only or loosely compared token ("==" on a prefix, startsWith, missing scheme check) lets an attacker
  //      with a partial or malformed credential in. Each variant differs from the real token in exactly one way.
  // proves: CLAIM(MC15)
  it("[MC15] rejects wrong, truncated, extended, empty, wrong-scheme and out-of-header credentials with 401", async () => {
    const { server } = await viewers.start();
    const token = server.token;
    const flipped = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    const attempts: Array<[string, string, Record<string, string>]> = [
      ["wrong last char", "/api/index", bearer(flipped)],
      ["prefix (one char short)", "/api/index", bearer(token.slice(0, -1))],
      ["token plus suffix", "/api/index", bearer(`${token}x`)],
      ["empty bearer", "/api/index", { Authorization: "Bearer " }],
      ["wrong scheme", "/api/index", { Authorization: `Basic ${token}` }],
      ["token without scheme", "/api/index", { Authorization: token }],
      ["token in query string", `/api/index?token=${token}`, {}],
      ["token in cookie", "/api/index", { Cookie: `token=${token}` }],
    ];
    for (const [label, route, headers] of attempts) {
      const reply = await rawRequest(server, route, { headers });
      expect(reply.status, `${label}: ${reply.text.slice(0, 120)}`).toBe(401);
    }
    const control = await rawRequest(server, "/api/index", { headers: bearer(token) });
    expect(control.status).toBe(200);
  });

  // why: with the right token, the read routes return JSON the browser can use; /api/view serves the stored
  //      snapshot (a cell value of the stored list proves it is the registered data, not a placeholder).
  // proves: CLAIM(MC15), CLAIM(MC20)
  it("[MC15] with the correct token the read routes answer 200 application/json", async () => {
    const { server } = await viewers.start();
    for (const route of ["/api/index", "/api/registry", "/api/search?q=cancel", `/api/view?${VIEW_QUERY}`, `/api/entity?${WATCH_QUERY}`]) {
      const reply = await rawRequest(server, route, { headers: bearer(server.token) });
      expect(reply.status, `${route}: ${reply.text.slice(0, 200)}`).toBe(200);
      expect(String(reply.headers["content-type"])).toMatch(/^application\/json/i);
      jsonOf(reply, route);
    }
    const view = await rawRequest(server, `/api/view?${VIEW_QUERY}`, { headers: bearer(server.token) });
    expect(view.text).toContain('"mcp.rs"');
  });
});

describe("viewer server: foreign pages and Host header", () => {
  // why: without CORS headers a browser blocks a foreign page from READING any response (design 5 "reject foreign
  //      browser origins"); one stray Access-Control-Allow-Origin would defeat the token for page-initiated reads.
  //      The response set covers success, auth failure, host failure, not-found, static, and a pre-flight (whatever its
  //      status: without an Allow-Origin header the browser refuses the pre-flight itself).
  // proves: CLAIM(MC15)
  it("[MC15] no response, including a cross-origin pre-flight answer, carries an Access-Control-* header", async () => {
    const { server } = await viewers.start();
    const own = { Origin: server.origin };
    const replies = [
      await rawRequest(server, "/api/index", { headers: { ...bearer(server.token), ...own } }),
      await rawRequest(server, "/api/index", { headers: { Origin: "http://evil.example" } }),
      await rawRequest(server, "/api/index", { headers: { ...bearer(server.token), Host: "evil.example" } }),
      await rawRequest(server, "/api/nope", { headers: bearer(server.token) }),
      await rawRequest(server, "/", {}),
      await rawRequest(server, "/assets/app.js", {}),
    ];
    expect(replies.map((reply) => reply.status)).toEqual([200, 401, 403, 404, 200, 200]);
    const preflight = await rawRequest(server, "/api/notebooks/p/revisions", {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    expect(preflight.status, "the pre-flight gets an answer, not a hang or a crash").toBeGreaterThan(0);
    expect(preflight.status).toBeLessThan(500);
    for (const reply of [...replies, preflight]) {
      const cors = Object.keys(reply.headers).filter((name) => name.toLowerCase().startsWith("access-control-"));
      expect(cors, `status ${reply.status}`).toEqual([]);
    }
  });

  // why: DNS rebinding: an attacker's name that resolves to 127.0.0.1 sends `Host: evil.example`; the server must
  //      only answer its own host:port (red-contract 8), on pages and on /api even with a VALID token.
  // proves: CLAIM(MC15)
  describe.each(["/", "/assets/app.js", "/api/index"])("path %s", (path) => {
    it("[MC15] answers 403 FORBIDDEN_ORIGIN to Host: evil.example and 200 to its own Host", async () => {
      const { server } = await viewers.start();
      const headers = bearer(server.token);
      const attack = await rawRequest(server, path, { headers: { ...headers, Host: "evil.example" } });
      expectErrorBody(attack, 403, "FORBIDDEN_ORIGIN");
      const own = await rawRequest(server, path, { headers: { ...headers, Host: `127.0.0.1:${server.port}` } });
      expect(own.status).toBe(200);
    });
  });

  // why: look-alike Host values must not pass a loose check (suffix/prefix/port-less comparison).
  // proves: CLAIM(MC15)
  it("[MC15] rejects look-alike Host headers: wrong port, no port, attacker name with the real port, look-alike suffix", async () => {
    const { server } = await viewers.start();
    const hosts = ["127.0.0.1", "127.0.0.1:1", `evil.example:${server.port}`, `127.0.0.1.evil.example:${server.port}`];
    for (const host of hosts) {
      const reply = await rawRequest(server, "/", { headers: { Host: host } });
      expect(reply.status, `Host: ${host}`).toBe(403);
    }
  });
});

describe("viewer server: notebook writes", () => {
  async function startWithPage() {
    const running = await viewers.start();
    const page = must(await running.session.notebookCreate(wireJson("notebook-create.json").input), "notebookCreate");
    const body = JSON.stringify(wireJson("http-revision-body.json"));
    const target = `/api/notebooks/${page.pageId}/revisions`;
    const before = must(await running.session.notebookGet(page.pageId), "notebookGet before");
    expect(before.revision).toBe(1); // a fresh page starts at revision 1 (design 4, notebook_create "revision 1")
    const post = (headers: Record<string, string>, requestBody = body) =>
      rawRequest(running.server, target, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: requestBody });
    const unchanged = async () => expect(must(await running.session.notebookGet(page.pageId), "notebookGet after")).toEqual(before);
    return { ...running, page, before, post, unchanged };
  }

  // why: a web page the user visits could POST to the local port; the token is also needed, but defence in depth
  //      requires a foreign Origin to be refused even WITH a valid token and the page must stay untouched
  //      (red-contract 8, MC15 "foreign-origin writes fail").
  // proves: CLAIM(MC15)
  it("[MC15] a write with Origin http://evil.example and a valid token is 403 FORBIDDEN_ORIGIN and nothing is written", async () => {
    const t = await startWithPage();
    const reply = await t.post({ ...bearer(t.server.token), Origin: "http://evil.example" });
    expectErrorBody(reply, 403, "FORBIDDEN_ORIGIN");
    await t.unchanged();
  });

  // why: "equal to the server origin" is exact: other schemes, hosts, ports and the opaque "null" origin are foreign.
  // proves: CLAIM(MC15)
  it("[MC15] near-miss origins (null, localhost, other port, https) are all refused and nothing is written", async () => {
    const t = await startWithPage();
    const origins = ["null", `http://localhost:${t.server.port}`, "http://127.0.0.1:1", `https://127.0.0.1:${t.server.port}`];
    for (const origin of origins) {
      const reply = await t.post({ ...bearer(t.server.token), Origin: origin });
      expect(reply.status, `Origin: ${origin}`).toBe(403);
    }
    await t.unchanged();
  });

  // why: the legitimate local client (same-origin browser) must work: positive control for the refusals above.
  //      Success is 200 or 201 (red-contract 8 names no status); the stored page is the arbiter.
  // proves: CLAIM(MC15), CLAIM(MC16)
  it("[MC15] the server's own Origin with a valid token creates revision 2 with the posted blocks", async () => {
    const t = await startWithPage();
    const reply = await t.post({ ...bearer(t.server.token), Origin: t.server.origin });
    expect([200, 201], reply.text.slice(0, 200)).toContain(reply.status);
    const after = must(await t.session.notebookGet(t.page.pageId), "notebookGet");
    expect(after.revision).toBe(2);
    expect(after.envelope.data).toEqual({ blocks: wireJson("http-revision-body.json").blocks });
  });

  // why: curl-style clients send no Origin; red-contract 8 says Origin "must be absent or equal", so absent is accepted.
  // proves: CLAIM(MC15)
  it("[MC15] a write with no Origin header and a valid token is accepted (revision 2)", async () => {
    const t = await startWithPage();
    const reply = await t.post(bearer(t.server.token));
    expect([200, 201], reply.text.slice(0, 200)).toContain(reply.status);
    expect(must(await t.session.notebookGet(t.page.pageId), "notebookGet").revision).toBe(2);
  });

  // why: a same-origin request without the token is still unauthenticated; a wrong token with the right origin too.
  // proves: CLAIM(MC15)
  it("[MC15] no token, or a wrong token, is 401 even with the server's own Origin, and nothing is written", async () => {
    const t = await startWithPage();
    expectErrorBody(await t.post({ Origin: t.server.origin }), 401, "UNAUTHORIZED");
    expectErrorBody(await t.post({ ...bearer(`${t.server.token}0`), Origin: t.server.origin }), 401, "UNAUTHORIZED");
    await t.unchanged();
  });

  // why: the browser editing a stale page must get CONFLICT with the current revision to retry from (design 5, MC16);
  //      status 409 is proposed in docs/contract-additions/wire.md (HTTP-2).
  // proves: CLAIM(MC16)
  it("[MC15] a write against a stale expectedRevision is 409 CONFLICT carrying currentRevision, and the page stays at revision 2", async () => {
    const t = await startWithPage();
    expect([200, 201]).toContain((await t.post(bearer(t.server.token))).status);
    const stale = await t.post(bearer(t.server.token)); // body still says expectedRevision 1
    const body = expectErrorBody(stale, 409, "CONFLICT");
    expect(body.details).toEqual({ currentRevision: 2 });
    expect(must(await t.session.notebookGet(t.page.pageId), "notebookGet").revision).toBe(2);
  });

  // why: a body that is not JSON is a client error, not a crash and not a write.
  // proves: CLAIM(MC15)
  it("[MC15] a malformed JSON body is a 400 paneweft.error/1 and nothing is written", async () => {
    const t = await startWithPage();
    const reply = await t.post(bearer(t.server.token), "{not json");
    expect(reply.status).toBe(400);
    expect(jsonOf(reply).schemaVersion).toBe("paneweft.error/1");
    await t.unchanged();
  });
});

describe("viewer server: nothing executes", () => {
  // why: notebook links and the browser must never run commands (design 5 "no route executes anything"; owner question 4).
  //      Every plausible run route answers 404 EVEN with a valid token, the server's own Origin and an argv payload.
  //      Control: a real route answers 200 in the same session, so the 404s are not a dead server.
  // proves: CLAIM(MC15), CLAIM(MC17)
  it("[MC15] run, exec and rerun routes are 404 paneweft.error/1 for GET and POST, and no command ran", async () => {
    const { server } = await viewers.start();
    const canary = join(makeTemp("canary"), "created-by-payload");
    const headers = { ...bearer(server.token), Origin: server.origin, "Content-Type": "application/json" };
    const payload = JSON.stringify({ argv: ["touch", canary], runner: { executable: "/usr/bin/touch", argv: [canary] } });
    const routes = ["/api/examples/vigil-one-write/run", "/api/examples/vigil-one-write/rerun", "/api/run", "/api/exec", "/api/runners"];
    for (const method of ["GET", "POST"]) {
      for (const route of routes) {
        const reply = await rawRequest(server, route, { method, headers, body: method === "POST" ? payload : undefined });
        expectErrorBody(reply, 404, "NOT_FOUND");
      }
    }
    expect(existsSync(canary)).toBe(false);
    expect((await rawRequest(server, "/api/registry", { headers })).status).toBe(200);
  });
});

describe("viewer server: static files stay inside the assets directory", () => {
  // why: positive control for every traversal test below: the same route family serves the bundle, with a
  //      JavaScript content type and the exact bytes on disk (dist/viewer is built by test/global-setup.ts).
  // proves: CLAIM(MC15)
  it("[MC15] control: GET /assets/app.js is 200 JavaScript identical to dist/viewer/app.js, and GET / is the index page", async () => {
    const { server } = await viewers.start();
    const asset = await rawRequest(server, "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(String(asset.headers["content-type"])).toMatch(/javascript/i);
    expect(asset.text).toBe(readFileSync(join(DIST_VIEWER, "app.js"), "utf8"));
    const index = await rawRequest(server, "/");
    expect(index.status).toBe(200);
    expect(String(index.headers["content-type"])).toMatch(/^text\/html/i);
    expect(index.text).toBe(readFileSync(join(DIST_VIEWER, "index.html"), "utf8"));
  });

  // why: with the default assetsDirectory (option omitted) the server must still find dist/viewer.
  // proves: CLAIM(MC15)
  it("[MC15] the default assetsDirectory serves /assets/app.js", async () => {
    const { session } = await viewers.session();
    const server = viewers.track(must(await startViewer({ session }), "startViewer"));
    const asset = await rawRequest(server, "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(String(asset.headers["content-type"])).toMatch(/javascript/i);
  });

  // why: path traversal in every spelling: plain, percent-encoded dots, encoded slash, absolute path, double slash, NUL,
  //      backslash, doubly-encoded. Targets: <repo>/package.json (two levels above dist/viewer) and /etc/passwd.
  //      The status must be 400/403/404 and the body must never contain either file (red-contract 8).
  //      Targets are sent byte for byte (rawRequest), not through URL normalisation.
  // proves: CLAIM(MC15)
  describe.each([
    "/assets/../../package.json",
    "/assets/%2e%2e/%2e%2e/package.json",
    "/assets/..%2f..%2fpackage.json",
    "/assets/%2E%2E%2F%2E%2E%2Fpackage.json",
    "/assets/....//....//package.json",
    "/assets/%252e%252e/%252e%252e/package.json",
    "/assets/..\\..\\package.json",
    "/assets/%5c..%5c..%5cpackage.json",
    "/assets/app.js/../../../package.json",
    "/assets/%00../../package.json",
    "/assets/app.js%00.txt",
    "/assets//etc/passwd",
    "/assets/%2fetc%2fpasswd",
    "/assets/../../../../../../../etc/passwd",
    "/../package.json",
    "/%2e%2e/package.json",
  ])("target %s", (target) => {
    it("[MC15] is refused (400/403/404) and leaks neither package.json nor /etc/passwd", async () => {
      const { server } = await viewers.start();
      const reply = await rawRequest(server, target);
      expect([400, 403, 404], `status ${reply.status} for ${target}`).toContain(reply.status);
      expect(reply.text).not.toContain('"name": "paneweft"');
      expect(reply.text).not.toContain("root:");
    });
  });

  // why: a symlink inside the assets directory that points outside it is a traversal by another name (design 5
  //      "reject traversal and symlink escape"). Control: a regular file in the same directory is served.
  // proves: CLAIM(MC15)
  it("[MC15] a symlink to a file or directory outside the assets directory is not served; a regular file beside it is", async () => {
    const outside = makeTemp("outside");
    writeFileSync(join(outside, "secret.txt"), "SECRET-OUTSIDE-9d41");
    const assets = makeTemp("assets");
    writeFileSync(join(assets, "ok.js"), "// ok-asset\n");
    symlinkSync(join(outside, "secret.txt"), join(assets, "leak.txt"));
    symlinkSync(outside, join(assets, "dirlink"));
    const { server } = await viewers.start({}, { assetsDirectory: assets });
    const control = await rawRequest(server, "/assets/ok.js");
    expect(control.status).toBe(200);
    expect(control.text).toBe("// ok-asset\n");
    for (const target of ["/assets/leak.txt", "/assets/dirlink/secret.txt"]) {
      const reply = await rawRequest(server, target);
      expect([400, 403, 404], target).toContain(reply.status);
      expect(reply.text).not.toContain("SECRET-OUTSIDE-9d41");
    }
  });
});

describe("viewer server: /api/source takes ids, never paths", () => {
  // why: design 5 "resolves only against the registered repository root and recorded snapshot": a path query
  //      parameter or a traversal in itemId must not become a file read, whatever the repository registration.
  // proves: CLAIM(MC15), CLAIM(MC20)
  it("[MC15] /api/source with path=/etc/passwd or itemId=../../etc/passwd is 400/404 and returns no file content", async () => {
    const { server } = await viewers.start();
    const headers = bearer(server.token);
    for (const query of [
      "path=/etc/passwd",
      "viewId=check-source&snapshotId=snap-1&itemId=..%2F..%2Fetc%2Fpasswd",
      "viewId=check-source&snapshotId=snap-1&itemId=../../etc/passwd",
      "viewId=..%2F..%2Fetc%2Fpasswd&snapshotId=snap-1&itemId=a",
    ]) {
      const reply = await rawRequest(server, `/api/source?${query}`, { headers });
      expect([400, 404], `${query}: ${reply.text.slice(0, 160)}`).toContain(reply.status);
      expect(reply.text).not.toContain("root:");
    }
    // a stray path parameter next to valid ids is ignored: whatever the status, no file content comes back
    const extra = await rawRequest(server, "/api/source?viewId=check-source&snapshotId=snap-1&itemId=a&path=/etc/passwd", { headers });
    expect(extra.text).not.toContain("root:");
  });
});

describe("viewer server: server.json lifecycle and viewerUrl", () => {
  // why: other processes (CLI, MCP) discover the running viewer through server.json; it holds the credential, so it
  //      must be private (0600) and must disappear on close (red-contract 8, section 8 "removed on close").
  // proves: CLAIM(MC15)
  it("[MC15] server.json exists with mode 0600 and exactly {origin, token, pid} while running, and is gone after close", async () => {
    const { server, dir } = await viewers.start();
    const file = join(dir, "server.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const content = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(content).sort()).toEqual(["origin", "pid", "token"]);
    expect(content).toEqual({ origin: server.origin, token: server.token, pid: process.pid });
    await server.close();
    expect(existsSync(file)).toBe(false);
    expect((await tcpProbe("127.0.0.1", server.port)).result).toBe("failed");
  });

  // why: render hands the agent a link only while a viewer runs: viewerUrl equals urlFor(viewKey) then, and null before
  //      and after (red-contract 8, "`null` without server.json"). A stale URL would point at a dead or foreign port.
  // proves: CLAIM(MC15)
  it("[MC15] render returns viewerUrl equal to urlFor(viewKey) while the server runs, and null before and after", async () => {
    const { session } = await viewers.session();
    const request = wireJson("render-valid-json.json");
    const viewerUrlOf = async () => jsonOf({ status: 200, headers: {}, text: (await executeOperation(session, "render", request)).body }, "render body").viewerUrl;
    expect(await viewerUrlOf()).toBeNull();
    const server = viewers.track(must(await startViewer({ session, assetsDirectory: DIST_VIEWER }), "startViewer"));
    expect(await viewerUrlOf()).toBe(server.urlFor({ viewId: "modules", snapshotId: "snap-1" }));
    await server.close();
    expect(await viewerUrlOf()).toBeNull();
  });
});

describe("viewer server: /api/source freshness (MC6)", () => {
  // The repository `r` is a copy of fixtures/wire/repo. fixtures/wire/view-source-live.json records the sha256 of
  // src/check.ts (computed with sha256sum, not by the code under test) and the stored excerpt of lines 3..5.
  const STORED_LINES = [
    { n: 3, text: '  const denied = "denied";' },
    { n: 4, text: "  if (!allowed) return denied;" },
    { n: 5, text: '  return "ok";' },
  ];
  const REVISION = "0123456789abcdef0123456789abcdef01234567"; // gitRev recorded in the fixture envelope's freshness
  async function startLive(registerRepository: boolean) {
    const root = makeTemp("repo");
    cpSync(wirePath("repo"), root, { recursive: true });
    const running = await viewers.start({ extraViews: ["view-source-live.json"], ...(registerRepository ? { repositoryRoot: root } : {}) });
    const get = (itemId: string) =>
      rawRequest(running.server, `/api/source?viewId=check-live&snapshotId=snap-1&itemId=${itemId}`, { headers: bearer(running.server.token) });
    return { ...running, root, get };
  }

  // why: click-through of an annotation must show the right bytes with FILE line numbers (3..5, not 1..3), highlight
  //      only the annotated line 4, and name the recorded revision (design MC6; red-contract 8 /api/source).
  //      Response field names are proposed in docs/contract-additions/wire.md (HTTP-3).
  // proves: CLAIM(MC6)
  it("[MC6] matching bytes: currency current, file-numbered lines 3..5, highlight [4,4] for the annotation, the recorded revision", async () => {
    const t = await startLive(true);
    const reply = await t.get("a");
    expect(reply.status, reply.text.slice(0, 200)).toBe(200);
    const body = jsonOf(reply);
    expect(body.currency).toBe("current");
    expect(body.numberedLines).toEqual(STORED_LINES);
    expect(body.highlight).toEqual([4, 4]);
    expect(body.revision).toBe(REVISION);
  });

  // why: the excerpt item itself highlights its whole range, not the annotation's: the highlight follows the item id.
  // proves: CLAIM(MC6)
  it("[MC6] the excerpt item highlights its whole range [3,5]", async () => {
    const t = await startLive(true);
    const body = jsonOf(await t.get("x"));
    expect(body.highlight).toEqual([3, 5]);
    expect(body.numberedLines).toEqual(STORED_LINES);
  });

  // why: after the local file changes, the old excerpt must stay visible (immutable snapshot) but be marked stale
  //      (design 4 "If local bytes no longer match the recorded hash, click-through offers the stored excerpt and
  //      identifies the mismatch"). Mutation target: serving the NEW bytes, or still saying current.
  // proves: CLAIM(MC6)
  it("[MC6] after the file is modified: currency stale and the stored lines are still returned unchanged", async () => {
    const t = await startLive(true);
    expect(jsonOf(await t.get("a")).currency).toBe("current"); // control: same request before the edit
    writeFileSync(join(t.root, "src", "check.ts"), readFileSync(join(t.root, "src", "check.ts"), "utf8").replace("if (!allowed)", "if (allowed)"));
    const body = jsonOf(await t.get("a"));
    expect(body.currency).toBe("stale");
    expect(body.numberedLines).toEqual(STORED_LINES);
    expect(body.highlight).toEqual([4, 4]);
  });

  // why: with no registered repository root nothing can be compared: currency unknown, and the stored excerpt is
  //      still shown (design 4 freshness "unknown" is not "fresh" and not an error).
  // proves: CLAIM(MC6)
  it("[MC6] repository not registered: currency unknown, stored lines returned", async () => {
    const t = await startLive(false);
    const reply = await t.get("a");
    expect(reply.status, reply.text.slice(0, 200)).toBe(200);
    const body = jsonOf(reply);
    expect(body.currency).toBe("unknown");
    expect(body.numberedLines).toEqual(STORED_LINES);
  });
});

describe("viewer server: registering a view needs no rebuild (MC12)", () => {
  // why: registering a second list view for vigil/watch is data, not code: the served entity gains the definition
  //      immediately, the registry revision rises by exactly 1, and not a single byte of dist/viewer is touched
  //      (design 3, MC12 "without a browser rebuild"). The fingerprint probe is proven alive by a control mutation.
  // proves: CLAIM(MC12)
  it("[MC12] a registered definition appears in /api/entity, revision +1, dist/viewer byte- and mtime-identical", async () => {
    const probeDir = makeTemp("probe");
    writeFileSync(join(probeDir, "a.txt"), "one");
    const probeBefore = treeFingerprint(probeDir);
    writeFileSync(join(probeDir, "a.txt"), "two");
    expect(treeFingerprint(probeDir), "positive control: the probe must see a change").not.toEqual(probeBefore);

    const { session, server } = await viewers.start();
    const headers = bearer(server.token);
    const fingerprintBefore = treeFingerprint(DIST_VIEWER);
    expect(Object.keys(fingerprintBefore).sort(), "the built viewer is non-empty").toEqual(expect.arrayContaining(["app.js", "index.html"]));
    const registryBefore = jsonOf(await rawRequest(server, "/api/registry", { headers }), "registry before");
    const entityBefore = await rawRequest(server, `/api/entity?${WATCH_QUERY}`, { headers });
    expect(entityBefore.text).toContain('"def-modules"');
    expect(entityBefore.text).not.toContain('"def-modules-by-id"');

    const definition = { id: "def-modules-by-id", entityKind: "vigil/watch", title: "Modules by id", priority: 5, component: "list", requires: [], dataRole: "modules" };
    const registered = must(await session.registerView(definition, registryBefore.revision), "registerView");
    expect(registered.revision).toBe(registryBefore.revision + 1);

    const registryAfter = jsonOf(await rawRequest(server, "/api/registry", { headers }), "registry after");
    expect(registryAfter.revision).toBe(registryBefore.revision + 1);
    const entityAfter = await rawRequest(server, `/api/entity?${WATCH_QUERY}`, { headers });
    expect(entityAfter.status).toBe(200);
    expect(entityAfter.text).toContain('"def-modules-by-id"');
    expect(entityAfter.text).toContain('"def-modules"'); // existing definitions are still offered
    // exact-kind matching: the code/module entity has a different kind and must not gain the vigil/watch definition
    const otherKind = await rawRequest(server, "/api/entity?snapshot=snap-1&repository=r&id=mcp&kind=code%2Fmodule", { headers });
    expect(otherKind.text).not.toContain('"def-modules-by-id"');
    expect(treeFingerprint(DIST_VIEWER)).toEqual(fingerprintBefore);
  });
});

describe("viewer server: only validated, registered snapshots are served (MC20)", () => {
  // why: a bundle with one invalid member is refused as a whole (atomic import); neither its valid sibling nor the
  //      invalid member may become reachable through the viewer. Control: a registered view is served by the same route.
  // proves: CLAIM(MC20)
  it("[MC20] a view from a rejected bundle import is 404 (the valid sibling too); the index still lists exactly the seven", async () => {
    const { session, server } = await viewers.start();
    const base = allBundle();
    const goodSibling = patch(base.views[0], { op: "replace", path: "/id", value: "rejected-sibling" });
    const invalid = patch(base.views[0], { op: "replace", path: "/id", value: "rejected-invalid" }, { op: "add", path: "/data/rows/0/colour", value: "red" });
    const bundle = { ...clone(base), views: [...clone(base.views), goodSibling, invalid] };
    const error = mustFail(await session.importBundle(bundle), "importBundle(rejected)");
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["UNKNOWN_PROPERTY", "/views/8/data/rows/0/colour"]]);

    const headers = bearer(server.token);
    for (const viewId of ["rejected-sibling", "rejected-invalid"]) {
      const reply = await rawRequest(server, `/api/view?viewId=${viewId}&snapshotId=snap-1`, { headers });
      expectErrorBody(reply, 404, "NOT_FOUND");
    }
    expect((await rawRequest(server, `/api/view?${VIEW_QUERY}`, { headers })).status).toBe(200);
    const index = jsonOf(await rawRequest(server, "/api/index", { headers }), "index");
    expect(index.views.map((view: any) => view.viewId).sort()).toEqual(SEVEN_VIEW_IDS);
  });

  // why: the browser URL must not reach arbitrary local files: a valid envelope JSON file planted in the session
  //      directory but absent from the manifest is served by no route (design MC20 "must not grant an unregistered
  //      entity access to arbitrary local paths"). The marker makes any leak visible in any response body.
  // proves: CLAIM(MC20)
  it("[MC20] a stray unmanifested envelope file in the session directory is served by no route", async () => {
    const { dir, server } = await viewers.start();
    const marker = "STRAY-MARKER-7f3a9c";
    const stray = { ...wireJson("view-empty-complete.json"), id: "stray", title: marker };
    for (const where of ["stray.json", join("views", "stray.json"), join("snapshots", "snap-1", "stray.json")]) {
      mkdirSync(join(dir, where, ".."), { recursive: true });
      writeFileSync(join(dir, where), JSON.stringify(stray));
    }
    const headers = bearer(server.token);
    const queries = [
      "/api/view?viewId=stray&snapshotId=snap-1",
      "/api/view?viewId=..%2Fstray&snapshotId=snap-1",
      "/api/view?viewId=views%2Fstray&snapshotId=snap-1",
      `/api/view?path=${encodeURIComponent(join(dir, "stray.json"))}`,
      `/api/source?path=${encodeURIComponent(join(dir, "stray.json"))}`,
      "/assets/stray.json",
      "/assets/../stray.json",
      "/stray.json",
      "/api/stray.json",
      "/views/stray.json",
    ];
    for (const target of queries) {
      const reply = await rawRequest(server, target, { headers });
      expect(reply.status, target).not.toBe(200);
      expect(reply.text, target).not.toContain(marker);
    }
    expect((await rawRequest(server, `/api/view?${VIEW_QUERY}`, { headers })).status, "control: registered view is served").toBe(200);
    const index = jsonOf(await rawRequest(server, "/api/index", { headers }), "index");
    expect(JSON.stringify(index)).not.toContain(marker);
  });

  // why: the index is the browser's only catalogue; it must list exactly the seven imported views, and the same
  //      seven after the process restarts (a new session object over the same directory, a new server).
  // proves: CLAIM(MC20)
  it("[MC20] /api/index lists exactly the 7 imported views, also after restart with a new session and server", async () => {
    const first = await viewers.start();
    const listing = async (server: { token: string; port: number; host: string }) =>
      jsonOf(await rawRequest(server, "/api/index", { headers: bearer(server.token) }), "index").views.map((view: any) => `${view.viewId}@${view.snapshotId}`).sort();
    const expected = SEVEN_VIEW_IDS.map((id) => `${id}@snap-1`);
    expect(await listing(first.server)).toEqual(expected);
    await first.server.close();
    await first.session.close();
    const reopened = must(await openSession(first.dir), "reopen session");
    const server = viewers.track(must(await startViewer({ session: reopened, assetsDirectory: DIST_VIEWER }), "restart viewer"));
    expect(server.token).not.toBe(first.server.token);
    expect(await listing(server)).toEqual(expected);
    await server.close();
    await reopened.close();
  });
});

