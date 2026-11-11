// @vitest-environment jsdom
// @vitest-environment-options {"runScripts": "dangerously", "url": "http://localhost:3000/"}
// MC15 (DOM side): untrusted content stays data. Labels, cells, Markdown, claims, error messages and source text carry script
// tags, event-handler attributes, javascript: links and shell-like text (fixtures/goldens/hostile.bundle.json). The viewer must show
// them as text. vitest's jsdom does NOT run scripts by default; this file opts in (options docblock above) and PROVES with positive
// controls that a script element and an inline handler do execute here, so "nothing executed" is meaningful. The page's `window`
// differs from the test global, so payloads also mark execution on document.documentElement (data-pwned).
import { describe, expect, it } from "vitest";
import {
  SUBJECT, byId, click, elementsWithHandlerAttributes, fixedFresh, goldenBundle, need, onCleanup, openBundle, ownText, qa, q, text, typeInto,
  useViewerCleanup, withFailingSource, type MountedViewer,
} from "../../test/helpers/dom-harness.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

const MARK = "window.__pwned=1;document.documentElement.setAttribute('data-pwned','1')";
const PS = `<script>${MARK}</script>`;
const PI = `<img src=x onerror="${MARK}">`;
const PV = `"><svg onload="${MARK}">`;
const CMD1 = "$(rm -rf /)";
const CMD2 = "; touch /tmp/x";
const RAW_PAYLOADS = [PS, PI, PV, `javascript:window.__pwned=1`, `<b onclick="window.__pwned=1">`];

const pwned = (): boolean => document.documentElement.hasAttribute("data-pwned") || (document.defaultView as unknown as { __pwned?: unknown }).__pwned !== undefined;
const openHostile = (view: string, setup = {}): Promise<MountedViewer> =>
  openBundle(tmp(view), goldenBundle("hostile"), SUBJECT, `d-h-${view}`, { decorate: fixedFresh, ...setup });

describe("[MC15] positive controls: the environment can execute, and the checks can see it", () => {
  // why: if scripts never ran in this environment, every "no script executed" assertion below would be vacuous.
  // proves: CLAIM(MC15) (positive control)
  it("[MC15] a script element appended to the document DOES execute in this jsdom environment", () => {
    const script = document.createElement("script");
    script.textContent = "document.documentElement.setAttribute('data-ctl-script','ran')";
    document.body.append(script);
    expect(document.documentElement.getAttribute("data-ctl-script")).toBe("ran");
    document.documentElement.removeAttribute("data-ctl-script");
  });
  // why: same for inline event handlers, the second execution route the viewer must never create.
  // proves: CLAIM(MC15) (positive control)
  it("[MC15] an inline onclick attribute DOES execute when the element is clicked", () => {
    const button = document.createElement("button");
    button.setAttribute("onclick", "document.documentElement.setAttribute('data-ctl-click','ran')");
    document.body.append(button);
    button.click();
    expect(document.documentElement.getAttribute("data-ctl-click")).toBe("ran");
    document.documentElement.removeAttribute("data-ctl-click");
    button.remove();
  });
  // why: the on*-attribute walker is the check for "zero elements with on* attributes"; it must find a planted one and ignore clean markup.
  // proves: CLAIM(MC15) (positive control)
  it("[MC15] the handler-attribute walker finds a deliberately injected onerror and reports nothing for clean markup", () => {
    const host = document.createElement("div");
    host.innerHTML = '<p>clean</p><span data-pw="x" title="one">ok</span>';
    expect(elementsWithHandlerAttributes(host)).toEqual([]);
    host.querySelector("span")!.setAttribute("onmouseover", "x()");
    const italic = document.createElement("i");
    italic.setAttribute("ONERROR", "y()");
    host.append(italic);
    expect(elementsWithHandlerAttributes(host)).toEqual([{ tag: "SPAN", attribute: "onmouseover" }, { tag: "I", attribute: "onerror" }]);
  });
  // why: guards the vacuity of every escaping test: the fixture must really carry the payloads.
  // proves: CLAIM(MC15) (positive control)
  it("[MC15] the hostile fixture carries the script, img, svg and shell-like payloads in labels, cells, prose, claims, source and annotations", () => {
    const json = JSON.stringify(goldenBundle("hostile"));
    for (const payload of [PS, PI, PV, CMD1, CMD2, "javascript:window.__pwned=1"]) expect(json, payload).toContain(JSON.stringify(payload).slice(1, -1));
  });
});

describe("[MC15] hostile data renders as text", () => {
  const generic = (v: MountedViewer, view: string) => {
    expect(pwned(), `${view}: nothing executed`).toBe(false);
    expect(v.container.querySelectorAll("script, iframe, object, embed, img"), `${view}: no script/iframe/object/embed/img element`).toHaveLength(0);
    const strayOutsideGraph = Array.from(v.container.querySelectorAll("svg")).filter((s) => s.closest('[data-pw="graph"]') === null);
    expect(strayOutsideGraph, `${view}: no svg outside the graph`).toHaveLength(0);
    expect(elementsWithHandlerAttributes(v.container), `${view}: no on* attribute anywhere`).toEqual([]);
    expect(need(v.container, "pane").getAttribute("aria-label"), "the entity label stays inside its attribute").toBe(`Subject ${PV}`);
  };

  // why: cell text, labels and shell-like text must be shown verbatim (design 5 "Escape text").
  // proves: CLAIM(MC15)
  it("[MC15] list: a cell holding <script>…</script> is text; $(rm -rf /) and ; touch /tmp/x appear verbatim; no element or handler is created", async () => {
    const v = await openHostile("list");
    const cell = (rowId: string) => qa(byId(v.container, "row", rowId), "cell")[0]!;
    expect(cell("hr1").textContent).toBe(PS);
    expect(cell("hr2").textContent).toBe(CMD1);
    expect(cell("hr3").textContent).toBe(CMD2);
    expect(text(qa(v.container, "column-header")[0])).toBe(`Name ${PI}`);
    generic(v, "list");
  });
  // proves: CLAIM(MC15)
  it("[MC15] tree: an <img onerror> in a node cell is text", async () => {
    const v = await openHostile("tree");
    // depth-0 nodes start expanded (dom.md D), so ht2 is rendered without any interaction
    expect(qa(byId(v.container, "node", "ht1"), "cell")[0]!.textContent).toBe(PI);
    expect(qa(byId(v.container, "node", "ht2"), "cell")[0]!.textContent).toBe(CMD1);
    generic(v, "tree");
  });
  // proves: CLAIM(MC15)
  it("[MC15] graph: node labels, an edge relation and the edge list show the payloads as text inside the single svg", async () => {
    const v = await openHostile("graph");
    expect(ownText(byId(v.container, "graph-node", "hn1"))).toBe(PS);
    expect(ownText(byId(v.container, "graph-node", "hn2"))).toBe(CMD2);
    expect(text(need(byId(v.container, "graph-edge", "he1"), "edge-label"))).toBe(PI);
    expect(ownText(byId(v.container, "graph-edge-item", "he1"))).toBe(`hn1 -${PI}-> hn2`);
    expect(v.container.querySelectorAll("svg")).toHaveLength(1);
    generic(v, "graph");
  });
  // proves: CLAIM(MC15)
  it("[MC15] source: lines holding <script> and <img onerror> and an annotation holding \"><svg onload> are text", async () => {
    const v = await openHostile("source");
    await click(v, byId(v.container, "annotation", "ha1"));
    expect(qa(v.container, "source-line").map((l) => ownText(l))).toEqual([PS, PI, CMD1]);
    expect(text(byId(v.container, "annotation", "ha1"))).toBe(`${PV} (claims: C1)`);
    generic(v, "source");
  });
  // proves: CLAIM(MC15)
  it("[MC15] shape: a path attribute, a type and a string example holding payloads stay inert", async () => {
    const v = await openHostile("shape");
    const field = byId(v.container, "field", "hf1");
    expect(field.getAttribute("data-path")).toBe(PV);
    expect(text(need(field, "field-type"))).toBe(PI);
    expect(text(need(field, "field-example"))).toBe(JSON.stringify(PS));
    generic(v, "shape");
  });
  // proves: CLAIM(MC15)
  it("[MC15] notebook: a claim statement holding <script> is text, also after the claim is expanded", async () => {
    const v = await openHostile("notebook");
    expect(ownText(byId(v.container, "block", "hb2"))).toBe(PS);
    await click(v, need(byId(v.container, "block", "hb2"), "toggle"));
    expect(ownText(byId(v.container, "block", "hb2"))).toBe(PS);
    generic(v, "notebook");
  });
  // proves: CLAIM(MC15)
  it("[MC15] example: a scenario label holding \"><svg onload> and a parameter holding <script> are text", async () => {
    const v = await openHostile("example");
    expect(ownText(need(v.container, "scenario"))).toBe(`${PV} (runner-1)`);
    generic(v, "example");
  });
  // why: design 5 "sanitize Markdown": raw HTML shows as text, javascript:/data: links lose their link, image syntax makes no <img>,
  //      allowed links keep only href and rel="noopener noreferrer" (red-contract 7).
  // proves: CLAIM(MC15)
  it("[MC15] notebook Markdown: only http(s), mailto and # anchors survive with rel noopener noreferrer; javascript:/data: links and raw HTML are plain text", async () => {
    const v = await openHostile("notebook");
    const prose = need(byId(v.container, "block", "hb1"), "prose");
    const anchors = Array.from(prose.querySelectorAll("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1&c=2", "mailto:a@example.com", "#top"]);
    for (const a of anchors) {
      expect(a.getAttribute("rel")?.split(/\s+/).sort(), `rel of ${a.getAttribute("href")}`).toEqual(["noopener", "noreferrer"]);
      expect(Array.from(a.attributes).map((x) => x.name).sort(), "only href and rel").toEqual(["href", "rel"]);
    }
    expect(text(prose)).toMatch(/^Click js or data or ok or mail or frag/);
    expect(prose.textContent).toContain('<b onclick="window.__pwned=1">raw</b>');
    expect(prose.textContent).toContain(PS);
    expect(prose.querySelectorAll("script, img, b, svg, iframe")).toHaveLength(0);
    expect(Array.from(prose.querySelectorAll("*")).map((e) => e.tagName.toLowerCase()).filter((t) => !["p", "a", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "h1", "h2", "h3", "h4", "h5", "h6"].includes(t))).toEqual([]);
    expect(elementsWithHandlerAttributes(v.container)).toEqual([]);
    expect(pwned()).toBe(false);
  });
  // why: error messages come from data too (a path or label echoed by an operation) and must be text.
  // proves: CLAIM(MC15)
  it("[MC15] an error message holding <img onerror> is shown as text inside error role=alert", async () => {
    const v = await openHostile("source", { decorate: (s: Parameters<typeof fixedFresh>[0]) => withFailingSource(fixedFresh(s), "PATH_OUTSIDE_ROOT", PI) });
    await click(v, byId(v.container, "annotation", "ha1"));
    const error = need(v.container, "error");
    expect(error.textContent).toBe(`PATH_OUTSIDE_ROOT: ${PI}`);
    expect(error.querySelectorAll("img")).toHaveLength(0);
    expect(elementsWithHandlerAttributes(v.container)).toEqual([]);
    expect(pwned()).toBe(false);
  });
  // why: the filter re-renders data; a payload typed into the filter box (which also equals a cell) must stay text everywhere it is echoed.
  // proves: CLAIM(MC15)
  it("[MC15] a payload typed into the filter box matches the cell holding it and is never reflected as markup", async () => {
    const v = await openHostile("list");
    await typeInto(v, need(v.container, "filter-input"), PS);
    expect(qa(v.container, "row").map((r) => r.getAttribute("data-id"))).toEqual(["hr1"]); // hr1's cell is exactly the payload: 1 of 3 match
    expect(text(need(v.container, "match-count"))).toBe("1 of 3 match");
    expect(qa(byId(v.container, "row", "hr1"), "cell")[0]!.textContent).toBe(PS);
    expect(v.container.querySelectorAll("script")).toHaveLength(0);
    await typeInto(v, need(v.container, "filter-input"), `${PS}x`);
    expect(text(need(v.container, "empty-state"))).toBe("no items match the current filters (0 of 3)");
    expect(pwned()).toBe(false);
  });
});

describe("[MC15] the viewer never builds markup from data with innerHTML", () => {
  const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a"]);
  /** Records every string written through the HTML-parsing sinks of Element (innerHTML, outerHTML, insertAdjacentHTML). */
  function recordHtmlSinks(): string[] {
    const records: string[] = [];
    for (const name of ["innerHTML", "outerHTML"] as const) {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, name);
      if (original?.set === undefined) throw new Error(`Element.prototype.${name} has no setter in this environment`);
      Object.defineProperty(Element.prototype, name, { ...original, set(this: Element, value: string) { records.push(String(value)); original.set!.call(this, value); } });
      onCleanup(() => Object.defineProperty(Element.prototype, name, original));
    }
    const insert = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (this: Element, position: InsertPosition, html: string) { records.push(String(html)); return insert.call(this, position, html); };
    onCleanup(() => { Element.prototype.insertAdjacentHTML = insert; });
    return records;
  }
  const disallowedTags = (records: string[]): string[] =>
    records.flatMap((html) => Array.from(html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g), (m) => m[1]!.toLowerCase())).filter((t) => !ALLOWED_TAGS.has(t));
  const anchorAttributes = (records: string[]): string[] =>
    records.flatMap((html) => Array.from(html.matchAll(/<a\s+([^>]*)>/g), (m) => Array.from(m[1]!.matchAll(/([a-zA-Z-]+)="[^"]*"/g), (a) => a[1]!.toLowerCase()))).flat().filter((n) => n !== "href" && n !== "rel");

  // why: the spy is only evidence if it records; the tag checker is only evidence if it flags a disallowed tag.
  // proves: CLAIM(MC15) (positive control)
  it("[MC15] positive control: a deliberate innerHTML assignment is recorded and the tag check flags <img>", () => {
    const records = recordHtmlSinks();
    document.createElement("div").innerHTML = '<i>x</i>';
    document.createElement("div").insertAdjacentHTML("beforeend", PI);
    expect(records).toEqual(["<i>x</i>", PI]);
    expect(disallowedTags(records)).toEqual(["i", "img"]);
    expect(disallowedTags(["<p>ok <a href=\"#x\" rel=\"noopener noreferrer\">y</a></p>"])).toEqual([]);
    expect(anchorAttributes(['<a href="#x" onclick="y()" rel="noopener">'])).toEqual(["onclick"]);
  });
  // why: design 5 "never innerHTML except sanitised Markdown": whatever the viewer assigns must hold only the sanitiser's tags,
  //      contain no raw payload, and anchors only href/rel. Exercised across all seven hostile views and the interactive routes.
  // proves: CLAIM(MC15)
  it("[MC15] across all seven hostile views, every HTML string the viewer writes contains only sanitised-Markdown tags and no raw payload", async () => {
    const records = recordHtmlSinks();
    for (const view of ["list", "tree", "graph", "source", "shape", "notebook", "example"]) {
      const v = await openHostile(view);
      if (view === "source") await click(v, byId(v.container, "annotation", "ha1"));
      if (view === "notebook") await click(v, need(byId(v.container, "block", "hb2"), "toggle"));
      if (view === "list") await typeInto(v, need(v.container, "filter-input"), "x");
      expect(q(v.container, "pane"), `${view} rendered`).not.toBeNull();
    }
    for (const record of records) for (const payload of RAW_PAYLOADS) expect(record, `raw payload in an HTML write`).not.toContain(payload);
    expect(disallowedTags(records)).toEqual([]);
    expect(anchorAttributes(records)).toEqual([]);
  });
});
