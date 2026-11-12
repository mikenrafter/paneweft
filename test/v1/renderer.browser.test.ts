// The repo-owned renderer proof in a REAL browser (headless Chrome via puppeteer-core), under the PRODUCTION viewer server and its
// production headers (amendments S4, N3; IV12, IV13). jsdom would not prove any of the sandbox properties, so it is not used here.
// Every assertion about "blocked" has a positive control: the counter origin provably records a request when one is allowed.
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { runExample } from "../../packages/paneweft-ts/src/example.ts";
import { workMapping } from "../../fixtures/packages/containmarks-lite/tests/mappings.examples.ts";
import { reconcile } from "../../src/v1/adapters.ts";
import { startViewer } from "../../src/viewer/server.ts";
import { importCollection } from "../../src/v1/import.ts";
import { openTrustStore, rendererResponseHeaders, RENDERER_IFRAME_SANDBOX } from "../../src/v1/renderer.ts";
import { DIST_VIEWER } from "../helpers/wire-http.ts";
import { FIXTURES, collectionImport, loadFixture, useV1Sessions } from "../helpers/v1-world.ts";
import { must } from "../helpers/must.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const digests = loadFixture<any>("renderers/DIGESTS.json").renderers;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function chromePath(): string {
  const candidates = [process.env.PANEWEFT_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean) as string[];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) assert.fail(`no Chrome found (tried ${candidates.join(", ")}); the renderer sandbox must be proven in a real browser - set PANEWEFT_CHROME`);
  return found;
}

/** A second origin that records every request that reaches it (HTTP, and WebSocket upgrades). */
async function counterOrigin(): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "image/gif" });
    response.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
  });
  server.on("upgrade", (request, socket) => { hits.push(`UPGRADE ${request.url}`); socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

interface Stage { page: Page; browser: Browser; server: any; counter: { origin: string; hits: string[] }; responses: Array<{ url: string; status: number; headers: Record<string, string>; requestHeaders: Record<string, string> }>; url(view: string): string; dir: string }

/** One session with five custom views of the mapping object: trusted card, hostile probe, misbehaving, an untrusted card (a real directory nobody trusted) and a card captured with other bytes than the ones under the root. */
async function stage(): Promise<Stage> {
  const { session, dir } = await open();
  const repoRoot = tmp("cm-root");
  cpSync(join(FIXTURES, "renderers"), join(repoRoot, "renderers"), { recursive: true });
  // an untrusted renderer that EXISTS: the same bytes under another id, which no trust entry names (trust is per repository, id and digest)
  cpSync(join(repoRoot, "renderers/mapping-card"), join(repoRoot, "renderers/mapping-card-b"), { recursive: true });
  must(await session.registerRepository({ id: "cm", root: repoRoot }), "register root");
  const counter = await counterOrigin();
  const input = collectionImport("containmarks-mapping");
  // CLAIM(S34): the diagram is captured by the real code-owned SDK example, including its native assertion.
  const staging = tmp("cm-capture");
  vi.stubEnv("PANEWEFT_COLLECT", "1"); vi.stubEnv("PANEWEFT_RUN_ID", "run-2"); vi.stubEnv("PANEWEFT_STAGING_DIR", staging);
  let captured;
  try { captured = await runExample(workMapping); } finally { vi.unstubAllEnvs(); }
  expect(captured.failed).toBe(false);
  expect(captured.invocation.verified).toBe(true);
  const id = captured.invocation.id;
  const graph = JSON.parse(readFileSync(join(staging, "captures", `${id}.json`), "utf8"));
  input.graphs = [graph];
  input.run = must(reconcile("vitest", { runId: "run-2", selected: ["mapping.work"], testNames: { "mapping.work": "example:mapping.work" },
    exit: { code: 0, signal: null, timedOut: false, cancelled: false }, compile: "ok", skipped: [], filtered: [],
    invocations: [{ started: JSON.parse(readFileSync(join(staging, "invocations", `${id}.started.json`), "utf8")), completed: JSON.parse(readFileSync(join(staging, "invocations", `${id}.json`), "utf8")) }],
    native: { schemaVersion: "paneweft.vitest-report/1", runId: "run-2", vitestVersion: "5.1.0", tests: [{ name: "example:mapping.work", file: "mappings.paneweft.test.ts", state: "passed", errors: [], retries: 0 }], suites: [], unhandledErrors: [] },
  }), "real example reconciliation");
  const details = graph.views[0];
  const custom = (viewId: string, renderer: string, assetDigest: string, payload: object) => ({
    ...details, viewId, title: `Custom ${viewId}`, component: "custom", priority: 20,
    renderer: { id: renderer, apiVersion: 1, payloadSchemaDigest: (digests[renderer] ?? digests["mapping-card"]).payloadSchemaDigest, assetDigest },
    data: { renderer: { id: renderer, apiVersion: 1, payloadSchemaDigest: (digests[renderer] ?? digests["mapping-card"]).payloadSchemaDigest, assetDigest }, payload, objects: ["o1"], fallback: { component: "shape", data: details.data } },
  });
  graph.views.push(
    custom("mapping.hostile", "hostile", digests.hostile.digest, { counter: counter.origin }),
    custom("mapping.misbehaving", "misbehaving", digests.misbehaving.digest, {}),
    custom("mapping.untrusted", "mapping-card-b", digests["mapping-card"].digest, { originalIndex: 4, containerId: "firefox-container-3", backupName: "Work" }),
    custom("mapping.changed", "mapping-card", "e".repeat(64), { originalIndex: 4, containerId: "firefox-container-3", backupName: "Work" }),
  );
  graph.objects[0].views.push( "mapping.hostile", "mapping.misbehaving", "mapping.untrusted", "mapping.changed");
  must(await importCollection(session, input), "import");
  const trust = openTrustStore(dir);
  for (const id of ["mapping-card", "hostile", "misbehaving"]) must(await trust.trust({ repo: "cm", id, digest: digests[id].digest }), `trust ${id}`);
  const server = must(await startViewer({ session, assetsDirectory: DIST_VIEWER, sessionDirectory: dir }), "startViewer");
  cleanups.push(() => server.close());
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  const responses: Stage["responses"] = [];
  page.on("response", (response) => responses.push({ url: response.url(), status: response.status(), headers: response.headers(), requestHeaders: response.request().headers() }));
  return { page, browser, server, counter, responses, dir, url: (view) => `${server.origin}/#token=${server.token}&view=${graph.captureId}.o1.${view}&snapshot=snap-run-2` };
}

/** Fails the test by assertion (not by a puppeteer TimeoutError) when something does not happen. */
async function expectAppears<T>(what: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { return assert.fail(`${what}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
}
const frameOf = async (page: Page) => {
  const handle = await expectAppears("the sandboxed renderer iframe appears", () => page.waitForSelector('iframe[data-pw="renderer-frame"]', { timeout: 15_000 })) as any;
  const frame = await handle.contentFrame();
  assert.ok(frame, "the iframe has a frame");
  return { handle, frame };
};

describe("[IV12] a trusted renderer under production headers", () => {
  // why: IV12 / S4 / N3. The frame is delivered at /renderer/<digest>/<token>/index.html with the production headers, as a classic
  // script bundle, in an iframe whose sandbox is exactly allow-scripts, with no referrer; the parent page CSP allows framing self.
  // The asset requests carry no Authorization header (the sandboxed frame cannot send the session bearer).
  // proves: CLAIM(IV12) CLAIM(S4-renderer-delivery) CLAIM(N3-renderer-loading)
  it("serves, frames and sandboxes the renderer exactly as specified", async () => {
    const s = await stage();
    await s.page.goto(s.url("mapping.card"));
    const { handle } = await frameOf(s.page);
    const attributes = await handle.evaluate((el: Element) => ({ sandbox: el.getAttribute("sandbox"), referrer: el.getAttribute("referrerpolicy"), src: el.getAttribute("src") }));
    expect(attributes.sandbox).toBe(RENDERER_IFRAME_SANDBOX);
    expect(attributes.referrer).toBe("no-referrer");
    expect(attributes.src).toMatch(new RegExp(`^/renderer/${digests["mapping-card"].digest}/[A-Za-z0-9_-]{22,}/index\\.html$`));
    const frameDocument = s.responses.find((r) => r.url.endsWith("/index.html"));
    expect(frameDocument, "the frame document was requested").toBeDefined();
    const expected = rendererResponseHeaders();
    for (const [name, value] of Object.entries(expected)) expect(frameDocument!.headers[name.toLowerCase()], name).toBe(value);
    expect(Object.keys(frameDocument!.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    const isAsset = (r: { url: string }) => /\/renderer\/.*\.(js|css)$/.test(r.url);
    // The iframe exists before its assets arrive; retain the exact asset assertion after waiting.
    await expect.poll(() => s.responses.filter(isAsset).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    const assets = s.responses.filter(isAsset);
    expect(assets.map((r) => r.url.split("/").pop()).sort()).toEqual(["bundle.js", "style.css"]);
    for (const asset of [frameDocument!, ...assets]) { expect(asset.status).toBe(200); expect(asset.requestHeaders.authorization, "no bearer on frame asset requests").toBeUndefined(); }
    const parent = s.responses.find((r) => r.url.split("#")[0] === `${s.server.origin}/`);
    expect(parent?.headers["content-security-policy"], "the parent page CSP").toContain("frame-src 'self'");
    const html = await s.page.evaluate(async (url: string) => (await fetch(url)).text(), `${s.server.origin}${attributes.src}`);
    expect(html, "classic scripts only: no module scripts, no inline script").not.toMatch(/type=["']module["']|<script>[^<]/);
  }, 120_000);

  // why: IV12 / IV11 / week-one proof. The card draws the three facts as keyboard-operable items; Enter on the container item asks the
  // host to open the captured record, and the viewer opens it in ANOTHER pane (keyboard selection, not a static picture).
  // proves: CLAIM(IV12) CLAIM(IV11)
  it("renders the diagram and opens the captured record in another pane from the keyboard", async () => {
    const s = await stage();
    await s.page.goto(s.url("mapping.card"));
    const { frame } = await frameOf(s.page);
    await expectAppears("three card items", () => frame.waitForFunction(() => document.querySelectorAll('[data-pw="card-item"]').length === 3, { timeout: 10_000 }));
    expect(await frame.$$eval('[data-pw="card-item"]', (els: Element[]) => els.map((e: Element) => e.getAttribute("aria-label")))).toEqual(["original index: 4", "container ID: firefox-container-3", "backup name: Work"]);
    const before = (await s.page.$$('[data-pw="pane"]')).length;
    // Puppeteer's ElementHandle.focus rejects SVG elements; focus the same item inside the frame.
    await frame.evaluate(() => (document.querySelector('[data-id="container"]') as unknown as { focus(): void }).focus());
    await s.page.keyboard.press("Enter");
    await expectAppears("a second pane opens", () => s.page.waitForFunction((n: number) => document.querySelectorAll('[data-pw="pane"]').length > n, { timeout: 10_000 }, before));
    const text = await s.page.$eval('[data-pw="viewer"]', (el) => el.textContent ?? "");
    expect(text).toContain("firefox-container-3");
    expect(text).toContain("Work");
  }, 120_000);
});

describe("[IV12] everything a hostile renderer tries", () => {
  // why: IV12. Real-browser denial of fetch (same and cross origin), sockets, images, parent DOM access, top-level navigation, form
  // submission, storage, cookies, eval and inline script, and no bearer in the frame URL or referrer. Every probe reports `blocked`, the
  // counter origin saw ZERO requests, and the parent page did not navigate. Positive control: a direct request to the counter IS recorded.
  // proves: CLAIM(IV12) CLAIM(S4-renderer-delivery)
  it("blocks every probe and the counter origin sees nothing", async () => {
    const s = await stage();
    await fetch(`${s.counter.origin}/control`);
    expect(s.counter.hits, "positive control: the counter records a request that is allowed").toEqual(["GET /control"]);
    s.counter.hits.length = 0;
    await s.page.goto(s.url("mapping.hostile"));
    const { frame } = await frameOf(s.page);
    await expectAppears("the probes finish", () => frame.waitForFunction(() => (window as any).__probes?.__finished === true, { timeout: 20_000 }));
    const probes = await frame.evaluate(() => (window as any).__probes as Record<string, string>);
    const { __finished, ...results } = probes as any;
    expect(Object.keys(results).sort()).toEqual(["bearer-in-url", "cookie", "eval", "fetch-cross-origin", "fetch-same-origin-api", "form-submit", "image", "inline-script", "local-storage", "parent-document", "top-navigation", "websocket"]);
    for (const [name, outcome] of Object.entries(results)) expect(["blocked", "requested"], `${name} -> ${outcome}`).toContain(outcome);
    for (const name of ["fetch-cross-origin", "fetch-same-origin-api", "websocket", "image", "parent-document", "local-storage", "cookie", "eval", "inline-script", "bearer-in-url"]) expect(results[name], name).toBe("blocked");
    expect(s.counter.hits, "nothing reached the counter origin (form, navigation, image, socket, fetch)").toEqual([]);
    expect(s.page.url().startsWith(s.server.origin), "the parent did not navigate").toBe(true);
  }, 120_000);

  // why: IV12 (denial). A renderer whose digest is not trusted is never loaded: no iframe, no /renderer request, a visible notice with
  // its state, and the standard fallback shows the same domain facts.
  // proves: CLAIM(IV12) CLAIM(IV13)
  it("an untrusted digest shows the notice and the fallback, and requests nothing", async () => {
    const s = await stage();
    await s.page.goto(s.url("mapping.untrusted"));
    await expectAppears("the denial notice", () => s.page.waitForSelector('[data-pw="renderer-notice"][data-state="untrusted"]', { timeout: 15_000 }));
    expect(await s.page.$('iframe[data-pw="renderer-frame"]')).toBeNull();
    expect(s.responses.filter((r) => r.url.includes("/renderer/"))).toEqual([]);
    const fallback = await s.page.$eval('[data-pw="renderer-fallback"]', (el) => el.textContent ?? "");
    for (const fact of ["4", "firefox-container-3", "Work"]) expect(fallback).toContain(fact);
  }, 120_000);

  // why: F26. A value captured with other bytes than the ones under the root (here a digest no file has) is denied just the same, with the state `changed`, not `untrusted`
  // (no trust command could help: the digest names no files) and not `missing-asset` (the files are there). No iframe, no renderer request, the fallback shows the facts.
  // proves: CLAIM(IV12) CLAIM(F26-changed-since-capture)
  it("a value captured with other renderer bytes shows `changed` and the fallback, and requests nothing", async () => {
    const s = await stage();
    await s.page.goto(s.url("mapping.changed"));
    await expectAppears("the changed notice", () => s.page.waitForSelector('[data-pw="renderer-notice"][data-state="changed"]', { timeout: 15_000 }));
    expect(await s.page.$('iframe[data-pw="renderer-frame"]')).toBeNull();
    expect(s.responses.filter((r) => r.url.includes("/renderer/"))).toEqual([]);
    const notice = await s.page.$eval('[data-pw="renderer-notice"]', (el) => el.textContent ?? "");
    expect(notice).toContain("changed since this value was captured");
    const fallback = await s.page.$eval('[data-pw="renderer-fallback"]', (el) => el.textContent ?? "");
    for (const fact of ["4", "firefox-container-3", "Work"]) expect(fallback).toContain(fact);
  }, 120_000);

  // why: IV12 / IV13. A renderer that forges ids, snapshot, frame, message types, protocol version, oversize bodies and sequence
  // numbers is rejected message by message with a VISIBLE error count, opens no pane, and the unexpected self-reload revokes the port
  // (a later message is ignored and the notice says revoked).
  // proves: CLAIM(IV12) CLAIM(IV13)
  it("rejects forged messages visibly and revokes the port on an unexpected reload", async () => {
    const s = await stage();
    await s.page.goto(s.url("mapping.misbehaving"));
    await frameOf(s.page);
    const before = (await s.page.$$('[data-pw="pane"]')).length;
    await expectAppears("protocol errors are shown", () => s.page.waitForSelector('[data-pw="renderer-notice"][data-state="protocol-error"]', { timeout: 15_000 }));
    const rejected = await s.page.$eval('[data-pw="renderer-notice"]', (el) => el.getAttribute("data-rejected"));
    expect(Number(rejected), "seven forged messages were rejected").toBeGreaterThanOrEqual(7);
    expect((await s.page.$$('[data-pw="pane"]')).length, "no forged message opened a pane").toBe(before);
    await expectAppears("the reload revokes the port", () => s.page.waitForSelector('[data-pw="renderer-notice"][data-state="revoked"]', { timeout: 15_000 }));
  }, 120_000);
});
