// Corrected variants of two assertions of renderer.browser.test.ts (the red report found them unsatisfiable by ANY implementation).
// The repo-owned renderer proof in a REAL browser (headless Chrome via puppeteer-core), under the PRODUCTION viewer server and its
// production headers (amendments S4, N3; IV12, IV13). jsdom would not prove any of the sandbox properties, so it is not used here.
// Every assertion about "blocked" has a positive control: the counter origin provably records a request when one is allowed.
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterEach, assert, describe, expect, it } from "vitest";
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

/** One session with four custom views of the mapping object: trusted card, hostile probe, misbehaving, and an untrusted card. */
async function stage(): Promise<Stage> {
  const { session, dir } = await open();
  const repoRoot = tmp("cm-root");
  cpSync(join(FIXTURES, "renderers"), join(repoRoot, "renderers"), { recursive: true });
  must(await session.registerRepository({ id: "cm", root: repoRoot }), "register root");
  const counter = await counterOrigin();
  const input = collectionImport("containmarks-mapping");
  const graph = input.graphs[0] as any;
  const details = graph.views[0];
  const custom = (viewId: string, renderer: string, assetDigest: string, payload: object) => ({
    ...details, viewId, title: `Custom ${viewId}`, component: "custom", priority: 20,
    renderer: { id: renderer, apiVersion: 1, payloadSchemaDigest: digests[renderer].payloadSchemaDigest, assetDigest },
    data: { renderer: { id: renderer, apiVersion: 1, payloadSchemaDigest: digests[renderer].payloadSchemaDigest, assetDigest }, payload, objects: ["o1"], fallback: { component: "shape", data: details.data } },
  });
  graph.views.push(
    custom("mapping.card", "mapping-card", digests["mapping-card"].digest, { originalIndex: 4, containerId: "firefox-container-3", backupName: "Work" }),
    custom("mapping.hostile", "hostile", digests.hostile.digest, { counter: counter.origin }),
    custom("mapping.misbehaving", "misbehaving", digests.misbehaving.digest, {}),
    custom("mapping.untrusted", "mapping-card", "e".repeat(64), { originalIndex: 4, containerId: "firefox-container-3", backupName: "Work" }),
  );
  graph.objects[0].views.push("mapping.card", "mapping.hostile", "mapping.misbehaving", "mapping.untrusted");
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
  return { page, browser, server, counter, responses, dir, url: (view) => `${server.origin}/#token=${server.token}&view=inv-1.o1.${view}&snapshot=snap-run-2` };
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

describe("[IV12] a trusted renderer under production headers (corrected variants)", () => {
  // why: IV12 / S4 / N3, the part of renderer.browser.test.ts "serves, frames and sandboxes the renderer exactly as specified" that cannot be
  // reached there: puppeteer reports a navigation response URL WITH its fragment, so `r.url === origin + "/"` never matches and the
  // assertion on the parent page CSP can never run. Here the parent response is matched by its URL without the fragment. The frame
  // document, its headers, the two classic assets and the absent bearer are asserted exactly as in the original.
  // proves: CLAIM(IV12) CLAIM(S4-renderer-delivery) CLAIM(N3-renderer-loading)
  it("serves, frames and sandboxes the renderer exactly as specified, including the parent page CSP", async () => {
    const s = await stage();
    await s.page.goto(s.url("mapping.card"));
    const { handle } = await frameOf(s.page);
    const attributes = await handle.evaluate((el: Element) => ({ sandbox: el.getAttribute("sandbox"), referrer: el.getAttribute("referrerpolicy"), src: el.getAttribute("src") }));
    expect(attributes.sandbox).toBe(RENDERER_IFRAME_SANDBOX);
    expect(attributes.referrer).toBe("no-referrer");
    expect(attributes.src).toMatch(new RegExp(`^/renderer/${digests["mapping-card"].digest}/[A-Za-z0-9_-]{22,}/index\\.html$`));
    const frameDocument = s.responses.find((r) => r.url.endsWith("/index.html"));
    expect(frameDocument, "the frame document was requested").toBeDefined();
    for (const [name, value] of Object.entries(rendererResponseHeaders())) expect(frameDocument!.headers[name.toLowerCase()], name).toBe(value);
    const assets = s.responses.filter((r) => /\/renderer\/.*\.(js|css)$/.test(r.url));
    expect(assets.map((r) => r.url.split("/").pop()).sort()).toEqual(["bundle.js", "style.css"]);
    for (const asset of [frameDocument!, ...assets]) { expect(asset.status).toBe(200); expect(asset.requestHeaders.authorization, "no bearer on frame asset requests").toBeUndefined(); }
    const parent = s.responses.find((r) => r.url.split("#")[0] === `${s.server.origin}/`);
    expect(parent, "the parent page response (matched without its fragment)").toBeDefined();
    expect(parent!.headers["content-security-policy"], "the parent page CSP").toContain("frame-src 'self'");
    const html = await s.page.evaluate(async (url: string) => (await fetch(url)).text(), `${s.server.origin}${attributes.src}`);
    expect(html, "classic scripts only: no module scripts, no inline script").not.toMatch(/type=["']module["']|<script>[^<]/);
  }, 120_000);

  // why: IV12 / IV11, the keyboard proof of renderer.browser.test.ts. The original focuses the card item with puppeteer's
  // ElementHandle.focus(), which throws "Cannot focus non-HTMLElement" for the SVG <g> the fixture renderer draws. Here the same element is
  // focused with element.focus() inside the frame; Enter on it asks the host to open the captured record, and a second pane opens.
  // proves: CLAIM(IV12) CLAIM(IV11)
  it("renders the diagram and opens the captured record in another pane from the keyboard", async () => {
    const s = await stage();
    await s.page.goto(s.url("mapping.card"));
    const { frame } = await frameOf(s.page);
    await expectAppears("three card items", () => frame.waitForFunction(() => document.querySelectorAll('[data-pw="card-item"]').length === 3, { timeout: 10_000 }));
    expect(await frame.$$eval('[data-pw="card-item"]', (els: Element[]) => els.map((e: Element) => e.getAttribute("aria-label")))).toEqual(["original index: 4", "container ID: firefox-container-3", "backup name: Work"]);
    const before = (await s.page.$$('[data-pw="pane"]')).length;
    await frame.evaluate(() => (document.querySelector('[data-id="container"]') as unknown as { focus(): void }).focus());
    await s.page.keyboard.press("Enter");
    await expectAppears("a second pane opens", () => s.page.waitForFunction((n: number) => document.querySelectorAll('[data-pw="pane"]').length > n, { timeout: 10_000 }, before));
    const text = await s.page.$eval('[data-pw="viewer"]', (el) => el.textContent ?? "");
    expect(text).toContain("firefox-container-3");
    expect(text).toContain("Work");
  }, 120_000);
});
