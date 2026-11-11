// DOM test harness for the browser viewer (docs/viewer-dom-contract.md, docs/contract-additions/dom.md).
// Tests drive the viewer with DOM events only and observe `data-pw` elements. Every failure mode of the
// harness (missing element, unfocusable element, failed setup Result) is an assertion failure, never a throw
// from a stub, so a red run reads as "expected X, found nothing".
import { afterEach, assert } from "vitest";
import { createSessionSource, type ViewerSource, type ViewModel } from "../../src/viewer/source.ts";
import { mountViewer, type MountOptions, type ViewerHandle } from "../../src/viewer/mount.ts";
import { openSession } from "../../src/core/session.ts";
import type { RepositoryRegistration, Session } from "../../src/core/session.ts";
import type { Result } from "../../src/core/errors.ts";
import type { FreshnessResult } from "../../src/core/freshness.ts";
import type { EntityRef } from "../../src/core/wire.ts";
import { outline } from "./structure.ts";
import { must } from "./must.ts";
import { loadFixture } from "./fixtures.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./fixtures.ts";

export const SNAP = "snap-1";
export const SUBJECT: EntityRef = { repository: "r", id: "subject", kind: "demo/subject" };
export const node = (id: string): EntityRef => ({ repository: "r", id, kind: "nav/node" });

// ---------------------------------------------------------------- querying
export const sel = (name: string): string => `[data-pw="${name}"]`;
export const qa = (root: ParentNode, name: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel(name)));
export const q = (root: ParentNode, name: string): HTMLElement | null => root.querySelector<HTMLElement>(sel(name));
/** Like q, but a missing element is an assertion failure that names what was missing. */
export function need(root: ParentNode, name: string, context = "viewer"): HTMLElement {
  const found = q(root, name);
  if (found === null) assert.fail(`expected a [data-pw="${name}"] element in ${context}, found none`);
  return found;
}
export const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Text of `el` outside nested data-pw elements, whitespace collapsed (the same rule as outline()). */
export function ownText(el: Element): string {
  let out = "";
  const visit = (n: Node): void => {
    for (const child of Array.from(n.childNodes)) {
      if (child.nodeType === 3) out += child.textContent ?? "";
      else if (child.nodeType === 1 && !(child as Element).hasAttribute("data-pw")) visit(child);
    }
  };
  visit(el);
  return out.replace(/\s+/g, " ").trim();
}
export const attr = (el: Element | null | undefined, name: string): string | null => el?.getAttribute(name) ?? null;
export const ids = (elements: HTMLElement[], attribute = "data-id"): Array<string | null> => elements.map((e) => e.getAttribute(attribute));
/** Elements of `name` whose `data-id` is `id`. */
export function byId(root: ParentNode, name: string, id: string): HTMLElement {
  const found = qa(root, name).find((e) => e.getAttribute("data-id") === id);
  if (found === undefined) assert.fail(`expected [data-pw="${name}"][data-id="${id}"], present ids: ${JSON.stringify(ids(qa(root, name)))}`);
  return found;
}

// ---------------------------------------------------------------- fixtures
export const goldenBundle = (name: string): any => loadFixture<any>(`goldens/${name}.bundle.json`);
export const goldenOutline = (name: string): string => readFileSync(join(REPO_ROOT, "test", "goldens", `${name}.outline.txt`), "utf8");
export const CHECK_TS_PATH = join(REPO_ROOT, "fixtures", "goldens", "repo", "src", "check.ts");
export const checkTs = (): string => readFileSync(CHECK_TS_PATH, "utf8");

/** A repository root `root` holding src/check.ts exactly as committed (its sha256 is the one every fixture records), registered as `r`. */
export function sourceRepoSetup(root: string): RepositoryRegistration[] {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "check.ts"), checkTs());
  return [{ id: "r", root }];
}

/** Same bundle in another snapshot (entities, views and their links retagged); used for old-snapshot navigation. */
export function retagSnapshot(bundle: any, snapshotId: string): any {
  const copy = structuredClone(bundle);
  for (const e of copy.entities) e.snapshotId = snapshotId;
  for (const v of copy.views) { v.snapshotId = snapshotId; for (const l of v.links) l.snapshotId = snapshotId; }
  return copy;
}

// ---------------------------------------------------------------- mounting
export interface MountedViewer {
  container: HTMLElement;
  handle: ViewerHandle;
  session: Session;
  source: ViewerSource;
  dir: string;
}
export interface MountSetup {
  viewport?: { width: number; height: number };
  locale?: string;
  /** Wrap the session source (fixed freshness, injected errors, ...). */
  decorate?: (source: ViewerSource) => ViewerSource;
  repositories?: RepositoryRegistration[];
  /** Further bundles imported after the first (e.g. a second snapshot). */
  more?: unknown[];
}
const mounted: MountedViewer[] = [];
const restorers: Array<() => void> = [];
export function onCleanup(restore: () => void): void { restorers.push(restore); }
/** Call once per test file: destroys every viewer and removes its container after each test. */
export function useViewerCleanup(): void {
  afterEach(() => {
    for (const m of mounted.splice(0)) {
      try { m.handle.destroy(); } catch { /* destroy of a stub */ }
      m.container.remove();
    }
    for (const restore of restorers.splice(0)) restore();
    document.body.replaceChildren();
  });
}

/** Opens a session in `dir`, imports the bundle(s), registers repositories and mounts the viewer. Does not open an entity. */
export async function mountBundle(dir: string, bundle: unknown, setup: MountSetup = {}): Promise<MountedViewer> {
  const session = must(await openSession(dir), "openSession");
  must(await session.importBundle(bundle), "importBundle");
  for (const more of setup.more ?? []) must(await session.importBundle(more), "importBundle(more)");
  for (const repository of setup.repositories ?? []) must(await session.registerRepository(repository), "registerRepository");
  const base = createSessionSource(session);
  const source = setup.decorate ? setup.decorate(base) : base;
  const container = document.createElement("div");
  document.body.append(container);
  const options: MountOptions = { source, viewport: setup.viewport ?? { width: 1024, height: 768 }, locale: setup.locale ?? "en-US" };
  const handle = await mountViewer(container, options);
  const viewer: MountedViewer = { container, handle, session, source, dir };
  mounted.push(viewer);
  return viewer;
}
export async function idle(v: MountedViewer): Promise<void> { await v.handle.whenIdle(); }
export async function openEntity(v: MountedViewer, entity: EntityRef, preferred?: string, snapshotId = SNAP): Promise<void> {
  await v.handle.openEntity(entity, snapshotId, preferred);
  await v.handle.whenIdle();
}
/** mountBundle + open an entity in one step. */
export async function openBundle(dir: string, bundle: unknown, entity: EntityRef, preferred?: string, setup: MountSetup = {}): Promise<MountedViewer> {
  const v = await mountBundle(dir, bundle, setup);
  await openEntity(v, entity, preferred);
  return v;
}

// ---------------------------------------------------------------- source decorators (the viewer under test is unchanged)
export function withFreshness(source: ViewerSource, freshness: FreshnessResult): ViewerSource {
  const patchView = (result: Result<ViewModel>): Result<ViewModel> => (result.ok ? { ok: true, value: { ...result.value, freshness } } : result);
  return {
    ...passthrough(source),
    getViewFor: async (e, s, d) => patchView(await source.getViewFor(e, s, d)),
    getView: async (k) => patchView(await source.getView(k)),
  };
}
export const fixedFresh = (source: ViewerSource): ViewerSource => withFreshness(source, { status: "fresh" });

/** Every lookup that yields the envelope `viewId` reports NOT_FOUND (a deleted or never-stored target). */
export function withMissingView(source: ViewerSource, viewId: string): ViewerSource {
  const missing = (): Result<ViewModel> => ({ ok: false, error: { schemaVersion: "paneweft.error/1", code: "NOT_FOUND", message: `view ${viewId} does not exist`, errors: [], retryable: false } });
  const guard = (result: Result<ViewModel>): Result<ViewModel> => (result.ok && result.value.envelope.id === viewId ? missing() : result);
  return {
    ...passthrough(source),
    getViewFor: async (e, s, d) => guard(await source.getViewFor(e, s, d)),
    getView: async (k) => (k.viewId === viewId ? missing() : guard(await source.getView(k))),
  };
}
/** openItemSource fails with the given code and message. */
export function withFailingSource(source: ViewerSource, code: "PATH_OUTSIDE_ROOT" | "NOT_FOUND" | "INTERNAL", message: string): ViewerSource {
  return {
    ...passthrough(source),
    openItemSource: async () => ({ ok: false, error: { schemaVersion: "paneweft.error/1", code, message, errors: [], retryable: false } }),
  };
}
function passthrough(source: ViewerSource): ViewerSource {
  return {
    getEntity: (e, s) => source.getEntity(e, s),
    applicableViews: (e, s, p) => source.applicableViews(e, s, p),
    getViewFor: (e, s, d) => source.getViewFor(e, s, d),
    getView: (k) => source.getView(k),
    openItemSource: (k, i) => source.openItemSource(k, i),
    search: (qs, sc) => source.search(qs, sc),
    updateNotebook: (p, r, b) => source.updateNotebook(p, r, b),
  };
}

// ---------------------------------------------------------------- events (DOM only)
export async function click(v: MountedViewer, el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await v.handle.whenIdle();
}
/** Dispatches a keydown at `target` (default: the focused element), as a keyboard-only user would. */
export async function press(v: MountedViewer, key: string, target?: Element): Promise<void> {
  const at = target ?? document.activeElement ?? document.body;
  at.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await v.handle.whenIdle();
}
export async function typeInto(v: MountedViewer, input: HTMLElement, value: string): Promise<void> {
  const field = input as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await v.handle.whenIdle();
}
export function focusEl(el: HTMLElement, what = "element"): void {
  el.focus();
  assert.strictEqual(document.activeElement, el, `${what} must be focusable (tabindex or natively focusable); activeElement is ${document.activeElement?.tagName}[data-pw=${document.activeElement?.getAttribute("data-pw")}]`);
}
export async function toggleCheckbox(v: MountedViewer, box: HTMLElement): Promise<void> {
  const input = box as HTMLInputElement;
  input.checked = !input.checked;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await v.handle.whenIdle();
}

// ---------------------------------------------------------------- structure
export const panes = (v: MountedViewer): HTMLElement[] => qa(v.container, "pane");
export const visiblePanes = (v: MountedViewer): HTMLElement[] => panes(v).filter((p) => !p.hidden && !p.hasAttribute("hidden"));
export function paneAt(v: MountedViewer, index: number): HTMLElement {
  const found = panes(v).find((p) => p.getAttribute("data-pane-index") === String(index));
  if (found === undefined) assert.fail(`expected a pane with data-pane-index=${index}; panes: ${JSON.stringify(panes(v).map((p) => p.getAttribute("data-pane-index")))}`);
  return found;
}
export const paneEntityIds = (v: MountedViewer): Array<string | null> => panes(v).map((p) => p.getAttribute("data-entity-id"));
export const crumbs = (v: MountedViewer): HTMLElement[] => qa(v.container, "crumb");
export const trailIds = (v: MountedViewer): string[] => v.handle.state().trail.map((p) => p.entity.id);
export function selectedTab(pane: ParentNode): HTMLElement {
  const found = qa(pane, "tab").find((t) => t.getAttribute("aria-selected") === "true");
  if (found === undefined) assert.fail("expected a tab with aria-selected=true");
  return found;
}
export const tabDefinitionIds = (pane: ParentNode): Array<string | null> => qa(pane, "tab").map((t) => t.getAttribute("data-definition-id"));

/** Container elements whose own text is chrome (labels, option texts), not content: the golden does not pin it. */
const CHROME_TEXT = new Set(["viewer", "pane-trail", "pane", "view-tabs", "status-strip", "tabpanel", "claim-filter", "relation-filter", "graph", "graph-edge-list", "list", "tree", "shape", "source", "notebook", "example"]);
/**
 * Outline of the mounted viewer for goldens. Not pinned (docs/contract-additions/dom.md F): the text of the two built-in tabs,
 * the own text of container elements (labels and option texts around controls), and role/tabindex of evidence-link
 * (an SVG text needs a role, an HTML button does not).
 */
export function viewerOutline(container: ParentNode): string {
  const root = q(container, "viewer");
  if (root === null) return "(no [data-pw=viewer] element was rendered)\n";
  return outline(root).split("\n").map((line) => {
    const name = line.trimStart().split(" ")[0] ?? "";
    let out = line;
    if (/data-definition-id="builtin:/.test(out) || CHROME_TEXT.has(name)) out = out.replace(/ "(?:[^"\\]|\\.)*"$/, "");
    if (name === "evidence-link") out = out.replace(/ role="[^"]*"/, "").replace(/ tabindex="[^"]*"/, "");
    return out;
  }).join("\n");
}

// ---------------------------------------------------------------- focus and accessibility helpers
const NATURALLY_FOCUSABLE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]";
/** Elements a Tab key would visit, in DOM order (no positive tabindex is assumed; callers assert that separately). */
export function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(NATURALLY_FOCUSABLE)).filter((e) => {
    if (e.hasAttribute("disabled") || e.closest("[hidden]") !== null) return false;
    const tab = e.getAttribute("tabindex");
    return tab === null ? true : Number(tab) >= 0;
  });
}
/** Accessible name per the subset the viewer needs: aria-labelledby, aria-label, own text, label for inputs. */
export function accessibleName(el: HTMLElement): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby !== null) {
    const parts = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "");
    const joined = parts.join(" ").trim();
    if (joined !== "") return joined;
  }
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();
  if (el.tagName === "INPUT" || el.tagName === "SELECT") {
    const id = el.getAttribute("id");
    const forLabel = id === null ? null : document.querySelector(`label[for="${id}"]`);
    return (forLabel?.textContent ?? el.closest("label")?.textContent ?? "").trim();
  }
  return text(el);
}
/** Walks every element under `root` and returns those carrying an event-handler attribute (on*). */
export function elementsWithHandlerAttributes(root: ParentNode): Array<{ tag: string; attribute: string }> {
  const found: Array<{ tag: string; attribute: string }> = [];
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const a of Array.from(element.attributes)) if (a.name.toLowerCase().startsWith("on")) found.push({ tag: element.tagName, attribute: a.name });
  }
  return found;
}
