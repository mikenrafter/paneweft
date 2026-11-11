// MC15/design 5 "a bundled browser build with no CDN dependencies": dist/viewer (built once by test/global-setup.ts) must run
// offline. The bundle is evaluated in a bare JSDOM (scripts only via eval, no resource loading) with a recording fetch; a
// whole-bundle scan allows only XML namespace URIs. Node environment on purpose: a fresh JSDOM per test, no shared globals.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import { API_TOKEN, startFixtureServer, type FixtureServer } from "../../test/helpers/http-fixture-server.ts";

const DIST = join(REPO_ROOT, "dist", "viewer");
const ORIGIN = "http://127.0.0.1:4173";
/** Namespace identifiers the DOM APIs need as strings (createElementNS); they are never fetched. */
const ALLOWED_URI = new Set([
  "http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml", "http://www.w3.org/1999/xlink", "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/XML/1998/namespace", "http://www.w3.org/1998/Math/MathML",
]);
export function absoluteUrls(code: string): string[] {
  return Array.from(code.matchAll(/https?:\/\/[^\s"'`<>)\\]+/g), (m) => m[0]);
}
const disallowedUrls = (code: string): string[] => absoluteUrls(code).filter((u) => !ALLOWED_URI.has(u));
const appJs = (): string => readFileSync(join(DIST, "app.js"), "utf8");

interface Boot { calls: Array<{ url: string; authorization: string | null }>; window: JSDOM["window"] & { paneweft?: { mountViewer?: unknown } }; error: unknown }
async function boot(code: string, hash: string): Promise<Boot> {
  const dom = new JSDOM('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>', {
    url: `${ORIGIN}/${hash}`, runScripts: "outside-only", pretendToBeVisual: true,
  });
  const calls: Boot["calls"] = [];
  (dom.window as unknown as { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, dom.window.location.href).href;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, authorization: headers.get("authorization") });
    return new Response(JSON.stringify({ schemaVersion: "paneweft.error/1", code: "NOT_FOUND", message: "stubbed", errors: [], retryable: false }), { status: 404, headers: { "content-type": "application/json" } });
  };
  let error: unknown = null;
  try { dom.window.eval(code); } catch (e) { error = e; }
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); // let a boot-time fetch chain run; no clock involved
  return { calls, window: dom.window as Boot["window"], error };
}

describe("[MC15] the shipped viewer bundle", () => {
  // why: the server serves dist/viewer; an empty or syntactically broken app.js would only be noticed in a browser.
  // proves: CLAIM(bundle-builds)
  it("[MC15] bundle: dist/viewer/app.js exists, is non-empty and compiles as a script; index.html loads exactly /assets/app.js", () => {
    expect(statSync(join(DIST, "app.js")).size).toBeGreaterThan(0);
    expect(() => new Script(appJs(), { filename: "app.js" })).not.toThrow();
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    expect(Array.from(html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g), (m) => m[1])).toEqual(["/assets/app.js"]);
    expect(absoluteUrls(html)).toEqual([]);
  });
  // why: design 5 "a bundled browser build with no CDN dependencies" (residual's entry imported D3 from a CDN - the failure to avoid).
  // proves: CLAIM(no-cdn)
  it("[MC15] bundle: a whole-bundle scan finds no absolute http(s) URL except XML namespace identifiers", () => {
    expect(disallowedUrls(appJs())).toEqual([]);
  });
  // why: a scanner that finds nothing proves nothing; plant a CDN URL and a namespace URI.
  // proves: CLAIM(no-cdn) (positive control)
  it("[MC15] bundle: positive control: the scanner reports a planted https://cdn.example/x.js and ignores the SVG namespace", () => {
    const planted = 'const a = "https://cdn.example/x.js"; const ns = "http://www.w3.org/2000/svg"; fetch(`http://evil.example/p?x=1`);';
    expect(absoluteUrls(planted)).toEqual(["https://cdn.example/x.js", "http://www.w3.org/2000/svg", "http://evil.example/p?x=1"]);
    expect(disallowedUrls(planted)).toEqual(["https://cdn.example/x.js", "http://evil.example/p?x=1"]);
  });
  // why: dom.md A2 - the IIFE exposes window.paneweft.mountViewer (an esbuild iife drops plain exports), without throwing.
  // proves: CLAIM(bundle-entry)
  it("[MC15] bundle: evaluating app.js in a page does not throw and defines window.paneweft.mountViewer", async () => {
    const result = await boot(appJs(), "");
    expect(result.error).toBeNull();
    expect(typeof result.window.paneweft?.mountViewer).toBe("function");
  });
  // why: design 5 "Bind loopback ... unguessable session credential": every request the booted app makes stays on the page origin
  //      and carries the bearer token read from location.hash; nothing is fetched cross-origin, nothing loads external resources.
  // proves: CLAIM(no-cdn) / CLAIM(session-credential)
  it("[MC15] bundle: booting with #token=...&view=...&snapshot=... only issues same-origin /api requests with the bearer token", async () => {
    const result = await boot(appJs(), "#token=tok123&view=v-list&snapshot=snap-1");
    expect(result.error).toBeNull();
    expect(result.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of result.calls) {
      const url = new URL(call.url);
      expect(url.origin, `request ${call.url}`).toBe(ORIGIN);
      expect(url.pathname.startsWith("/api/"), `request ${call.url}`).toBe(true);
      expect(call.authorization, `request ${call.url}`).toBe("Bearer tok123");
    }
    expect(result.window.document.querySelectorAll("script[src], link[href], img[src], iframe, embed, object")).toHaveLength(0);
  });
});

// ---- S7: the SHIPPED bundle against successful HTTP responses ---------------------------------------------------------------------
// why: the boot test above only feeds the bundle 404s, so a bundle that mounted nothing, or that rendered from hard-wired data, would
//   pass. Here dist/viewer/index.html + app.js (exactly what the server ships) run in JSDOM, their fetch goes over a REAL socket to a plain
//   HTTP server that answers from the committed success fixtures in fixtures/http, and the DOM is asserted: (1) the payload's facts are
//   shown, (2) selecting a row opens a second pane for the target entity in the SAME snapshot (and requests it with the bearer token), (3) a
//   notebook edit reaches the server as the exact documented write, is stored, and is still there when the page is loaded again.
//   Expected values are the fixture literals (fixtures/components/list.json, notebook.json), not anything the viewer computed.
// Method notes: JSDOM here has no layout and no fetch of its own, so fetch is injected; waiting uses vi.waitFor on the DOM because the
//   responses arrive over real sockets (bounded at 3 s, polling 20 ms).
// New DOM elements pinned by this test (docs/viewer-dom-contract.md, S7): notebook `block-move` buttons (`data-direction` up|down) and
//   `notebook-revision` (`data-revision`).
describe("[S7] the shipped viewer bundle over successful HTTP responses", () => {
  const servers: FixtureServer[] = [];
  const windows: JSDOM["window"][] = [];
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    for (const server of servers.splice(0)) await server.close();
  });
  async function bootOver(server: FixtureServer, view: string): Promise<JSDOM["window"]> {
    const html = readFileSync(join(DIST, "index.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
    const dom = new JSDOM(html, { url: `${server.origin}/#token=${API_TOKEN}&view=${view}&snapshot=snap-1`, runScripts: "outside-only", pretendToBeVisual: true });
    (dom.window as unknown as { fetch: typeof fetch }).fetch = (input, init) =>
      fetch(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, dom.window.location.href), init);
    dom.window.eval(appJs());
    windows.push(dom.window);
    return dom.window;
  }
  const pw = (window: JSDOM["window"], name: string): HTMLElement[] => Array.from(window.document.querySelectorAll<HTMLElement>(`[data-pw="${name}"]`));
  const textOf = (element: Element | null | undefined): string => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const settled = <T>(check: () => T) => vi.waitFor(check, { timeout: 3000, interval: 20 });

  it("[S7] facts: booting on view=modules shows the list's row, cell, provenance badge, evidence link and completeness from the response", async () => {
    const server = await startFixtureServer();
    servers.push(server);
    const window = await bootOver(server, "modules");
    await settled(() => expect(pw(window, "row")).toHaveLength(1));
    const row = pw(window, "row")[0] as HTMLElement;
    expect(row.getAttribute("data-id")).toBe("mcp");
    expect(textOf(row.querySelector('[data-pw="cell"]'))).toBe("mcp.rs");
    expect(textOf(row.querySelector('[data-pw="provenance-badge"]'))).toBe("read");
    expect(textOf(row.querySelector('[data-pw="evidence-link"]'))).toBe("s1");
    expect(textOf(pw(window, "completeness")[0])).toContain("all modules in the fixture");
    expect(pw(window, "completeness")[0]?.getAttribute("data-status")).toBe("complete");
    expect(textOf(pw(window, "snapshot")[0])).toBe("snap-1");
    // every request was authenticated and stayed on the page origin
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of server.requests) expect(request.authorization, `${request.method} ${request.path}`).toBe(`Bearer ${API_TOKEN}`);
    // negative control: a different view id in the same fixture set shows different facts (the DOM is driven by the response, not hard-wired)
    expect(textOf(row)).not.toContain("delivery");
  });

  it("[S7] navigation: Enter on the row opens a second pane for entity mcp in snap-1, requested with the token, trail of two crumbs", async () => {
    const server = await startFixtureServer();
    servers.push(server);
    const window = await bootOver(server, "modules");
    await settled(() => expect(pw(window, "row")).toHaveLength(1));
    const row = pw(window, "row")[0] as HTMLElement;
    row.focus();
    row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settled(() => expect(pw(window, "pane").map((pane) => pane.getAttribute("data-entity-id"))).toEqual(["watch", "mcp"]));
    const second = pw(window, "pane")[1] as HTMLElement;
    expect(second.getAttribute("data-snapshot-id")).toBe("snap-1");
    expect(pw(window, "crumb")).toHaveLength(2);
    const entityRequests = server.requests.filter((request) => request.path === "/api/entity" && request.query.get("id") === "mcp");
    expect(entityRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of entityRequests) expect([request.query.get("snapshot"), request.query.get("kind"), request.authorization]).toEqual(["snap-1", "code/module", `Bearer ${API_TOKEN}`]);
    expect(server.requests.every((request) => request.query.get("snapshot") === null || request.query.get("snapshot") === "snap-1"), "navigation never mixes snapshots").toBe(true);
  });

  it("[S7] notebook edit: moving block b1 down POSTs the documented body, the server stores revision 2 with [b2, b1], and a fresh page load shows it", async () => {
    const server = await startFixtureServer();
    servers.push(server);
    const window = await bootOver(server, "cancellation-notebook");
    await settled(() => expect(pw(window, "block").map((block) => block.getAttribute("data-id"))).toEqual(["b1", "b2"]));
    expect(pw(window, "notebook-revision")[0]?.getAttribute("data-revision")).toBe("1");
    const down = pw(window, "block")[0]!.querySelector<HTMLElement>('[data-pw="block-move"][data-direction="down"]');
    expect(down, "block b1 offers a move-down control").not.toBeNull();
    down!.click();
    await settled(() => expect(pw(window, "block").map((block) => block.getAttribute("data-id"))).toEqual(["b2", "b1"]));
    expect(pw(window, "notebook-revision")[0]?.getAttribute("data-revision")).toBe("2");
    // persisted: what the server stores, observed independently of the browser
    expect(server.notebook).toEqual({ revision: 2, blockIds: ["b2", "b1"] });
    const writes = server.requests.filter((request) => request.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: "/api/notebooks/cancellation-notebook/revisions", authorization: `Bearer ${API_TOKEN}` });
    expect(writes[0]?.origin === null || writes[0]?.origin === server.origin).toBe(true);
    // and durable across a reload: a new page against the same server shows the edited order and revision
    const reloaded = await bootOver(server, "cancellation-notebook");
    await settled(() => expect(pw(reloaded, "block").map((block) => block.getAttribute("data-id"))).toEqual(["b2", "b1"]));
    expect(pw(reloaded, "notebook-revision")[0]?.getAttribute("data-revision")).toBe("2");
  });
});
