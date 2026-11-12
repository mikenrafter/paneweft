// D3 (consolidation): one validated reader of stored pages serves the CLI, the agent tools, V1Reader.page and the viewer. A page that is not
// there, a page that is not JSON and a page that is JSON but not a valid page of its view get the same verdict on every surface.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { canonical, collectionImport, sha256, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { must } from "../../test/helpers/must.ts";
import type { Result } from "../core/errors.ts";
import { createSessionSource } from "../viewer/session-source.ts";
import { importCollection } from "./import.ts";
import { captureFile, openV1Reader, pageFile, runDirectory, loadViewPages, readPageAt } from "./read.ts";
import { executeV1Operation } from "./tools.ts";

const open = useV1Sessions();
const Watch = defineType<{ rows: number }>({ id: "vigil::watch::WatchFile", source: { path: "src/watch.rs", symbol: "WatchFile" } });
Watch.view({
  id: "watch.events", title: "Events", question: "Which events were retained?", priority: 20, component: "list",
  render: (watch, view) => {
    const table = view.table().textColumn("event", "Event").numberColumn("tick", "Tick").orderBy("tick", "asc");
    for (let i = 0; i < watch.rows; i += 1) table.row({ id: `event-${String(i).padStart(4, "0")}`, cells: { event: `e-${i}`, tick: i } });
    return table.done();
  },
});

async function world(rows = 250) {
  const env = await open();
  const capture = new Capture({ captureId: "inv-1", runId: "run-1", invocationId: "inv-1" });
  capture.publish({ rows }, Watch);
  const input = collectionImport("vigil-redelivered");
  must(await importCollection(env.session, { ...input, graphs: [capture.finish().toJSON()] }), "import");
  return env;
}

type Env = Awaited<ReturnType<typeof world>>;
type Verdict = "ok" | "missing" | "corrupt" | string;

/** The first stored page of the table as the store knows it: its id, and the files that name it. */
function firstPage(env: Env): { pageId: string; objectId: string } {
  const graph = JSON.parse(readFileSync(captureFile(env.session, "run-1", "inv-1"), "utf8"));
  const view = graph.views.find((candidate: any) => candidate.viewId === "watch.events");
  return { pageId: view.pages[0].pageId, objectId: view.objectId };
}

/** Replaces the first stored page by a correctly addressed page holding `rows`: what admission used to let through. Every file that names the
 * page (the capture's view record and, where the store keeps one, the page references of the run) is pointed at it. */
function replaceFirstPage(env: Env, rows: unknown[]): void {
  const { pageId, objectId } = firstPage(env);
  const next = `sha256:${sha256(canonical(rows))}`;
  const file = captureFile(env.session, "run-1", "inv-1");
  const graph = JSON.parse(readFileSync(file, "utf8"));
  const view = graph.views.find((candidate: any) => candidate.viewId === "watch.events");
  view.pages[0] = { index: view.pages[0].index, pageId: next, rowCount: rows.length };
  writeFileSync(file, JSON.stringify(graph));
  writeFileSync(pageFile(env.session, next), JSON.stringify({ pageId: next, rows }));
  const refs = join(runDirectory(env.session, "run-1"), "page-refs.json");
  if (existsSync(refs)) writeFileSync(refs, readFileSync(refs, "utf8").replaceAll(pageId, next).replaceAll(/"rowCount":\d+/g, (match, offset: number, text: string) => (text.slice(Math.max(0, offset - 200), offset).includes(next) ? `"rowCount":${rows.length}` : match)));
}

const GOOD_ROW = { id: "fresh-1", cells: { event: "e", tick: 1 }, provenance: "observed", evidence: ["run"] };
const CASES: Array<[string, Verdict, (env: Env) => void]> = [
  ["untouched", "ok", () => {}],
  ["a page file that is gone", "missing", (env) => rmSync(pageFile(env.session, firstPage(env).pageId))],
  ["a page file that is not JSON", "corrupt", (env) => writeFileSync(pageFile(env.session, firstPage(env).pageId), "{\"pageId\": \"sha256:")],
  ["a page file that is JSON but not an object", "corrupt", (env) => writeFileSync(pageFile(env.session, firstPage(env).pageId), "[1,2,3]")],
  ["a page whose rows do not hash to its id", "corrupt", (env) => { const file = pageFile(env.session, firstPage(env).pageId); const page = JSON.parse(readFileSync(file, "utf8")); page.rows[0].cells.event = "tampered"; writeFileSync(file, JSON.stringify(page)); }],
  ["a correctly hashed page holding an empty row", "corrupt", (env) => replaceFirstPage(env, [{}])],
  ["a correctly hashed page with a cell of an undeclared column", "corrupt", (env) => replaceFirstPage(env, [{ ...GOOD_ROW, cells: { nope: 1 } }])],
  ["a correctly hashed page repeating a row id of the first page", "corrupt", (env) => replaceFirstPage(env, [{ ...GOOD_ROW, id: "event-0000" }])],
  ["a correctly hashed page with a row target that is not in the capture", "corrupt", (env) => replaceFirstPage(env, [{ ...GOOD_ROW, target: { object: "o99" } }])],
];

const text = (body: string): any => { try { return JSON.parse(body); } catch { return undefined; } };
function verdictOfReply(reply: { ok: boolean; body: string }): Verdict {
  const body = text(reply.body);
  if (!reply.ok) return body?.code === "STORAGE_CORRUPT" ? "corrupt" : `error ${body?.code ?? reply.body.slice(0, 80)}`;
  if (body?.completeness?.status === "complete") return body.items.length === 250 ? "ok" : `ok with ${body.items.length} rows`;
  return JSON.stringify(body?.completeness ?? "").includes("could not be read") ? "missing" : `partial ${JSON.stringify(body?.completeness).slice(0, 80)}`;
}

const surfaces: Record<string, (env: Env) => Promise<Verdict>> = {
  "the agent tool view_result": async (env) => verdictOfReply(await executeV1Operation({ session: env.session, sessionDir: env.dir, jobs: null }, "view_result", { run: "run-1", view: "watch.events", format: "json", maxBytes: 262_144 })),
  "the CLI command result": async (env) => {
    const run = await runCliInProcess(["--session", env.dir, "result", "--run", "run-1", "--view", "watch.events", "--format", "json", "--max-bytes", "262144"]);
    return verdictOfReply({ ok: run.exitCode === 0, body: run.exitCode === 0 ? run.stdout : run.stderr || run.stdout });
  },
  "V1Reader.page": async (env) => {
    const read = await openV1Reader(env.session).page({ runId: "run-1", captureId: "inv-1", objectId: firstPage(env).objectId, viewId: "watch.events", position: 1 } as never);
    if (read.ok) return "ok";
    return read.error.code === "NOT_FOUND" ? "missing" : read.error.code === "STORAGE_CORRUPT" ? "corrupt" : `error ${read.error.code}`;
  },
  "the viewer's session source": async (env) => {
    const entry = (await env.session.listViewIndex("snap-run-1")).find((candidate) => candidate.viewDefinitionId === "watch.events")!;
    const model = await createSessionSource(env.session).getView({ viewId: entry.viewId, snapshotId: "snap-run-1" });
    if (!model.ok) return model.error.code === "STORAGE_CORRUPT" ? "corrupt" : `error ${model.error.code}`;
    const completeness = model.value.envelope.completeness;
    if (completeness.status === "complete") return (model.value.envelope.data as { rows: unknown[] }).rows.length === 250 ? "ok" : "ok with the wrong rows";
    return JSON.stringify(completeness).includes("could not be read") ? "missing" : "partial";
  },
};

describe("[D3] every surface reads a stored page through one validated reader", () => {
  // why: D3 / S22. The tool, the viewer and V1Reader.page each had a reader of their own, and they disagreed: one accepted a correctly hashed
  // `rows: [{}]`, one treated malformed JSON as a missing page, one threw on it. A page is missing (the file is not there), corrupt (it is
  // there and is not a valid page of its view), or fine, and every surface says the same one. Rejects any surface that reads a page file itself.
  // proves: CLAIM(D3-one-reader)
  describe.each(CASES)("%s", (_name, verdict, damage) => {
    it.each(Object.entries(surfaces))(`is ${verdict} on %s`, async (_surface, observe) => {
      const env = await world();
      damage(env);
      expect(await observe(env)).toBe(verdict);
    });
  });

  // why: D3. The pages directory holds bodies only (one file per distinct body), so a reader that wants the owner of a page has to go through
  // the references: here, a body that exists but is referenced by no view of the run is never served.
  // proves: CLAIM(D3-one-reader) CLAIM(D2-page-ownership)
  it("serves only the pages a run's references name", async () => {
    const env = await world();
    expect(readdirSync(join(env.dir, "v1", "pages")).length).toBe(2);
    const stray = `sha256:${sha256(canonical([GOOD_ROW]))}`;
    writeFileSync(pageFile(env.session, stray), JSON.stringify({ pageId: stray, rows: [GOOD_ROW] }));
    for (const observe of Object.values(surfaces)) expect(await observe(env)).toBe("ok");
  });
});

// WHY CLAIM(S29): direct position-2 reads used to seed uniqueness with only the inline rows, accepting a duplicate from position 1.
it("[S29] direct reader rejects a duplicate in any preceding stored page", async () => {
  const env = await world();
  replaceFirstPage(env, [{ ...GOOD_ROW, id: "event-0200" }]);
  const result = await openV1Reader(env.session).page({ runId: "run-1", captureId: "inv-1", objectId: firstPage(env).objectId, viewId: "watch.events", position: 2 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("STORAGE_CORRUPT");
});
// WHY CLAIM(S30): unsupported shape/list records have no data; view_result must preserve the reason instead of dereferencing it.
it.each(["shape", "list", "custom"] as const)("[S30] view_result returns unsupported %s reason", async (component) => {
  const env = await open();
  const Token = defineType<object>({ id: `unsupported::${component}`, source: { path: "u.ts", symbol: "U" } });
  Token.view({ id: "u.view", title: "Unsupported", question: "Why?", component, priority: 1, render: (_o, cx) => cx.unsupported("no input available") });
  const capture = new Capture({ captureId: "inv-1", runId: "run-1", invocationId: "inv-1" });
  capture.publish({}, Token);
  must(await importCollection(env.session, { ...collectionImport("vigil-redelivered"), graphs: [capture.finish().toJSON()] }), "import");
  const reply = await executeV1Operation({ session: env.session, sessionDir: env.dir, jobs: null }, "view_result", { run: "run-1", view: "u.view", format: "json" });
  expect(reply.ok).toBe(true);
  expect(JSON.parse(reply.body).completeness).toEqual({ status: "unsupported", reason: "no input available" });
});

// WHY CLAIM(S29): concurrent calls must share a validated prefix without confusing positions or row-id sets.
it("[S29] concurrent direct reads retain their requested page positions", async () => {
  const env = await world();
  const view = must(await loadViewPages(env.session, { runId: "run-1", captureId: "inv-1", objectId: firstPage(env).objectId, viewId: "watch.events" }), "view");
  const pages = await Promise.all([readPageAt(view, 1), readPageAt(view, 2), readPageAt(view, 2)]);
  expect(pages.map((p) => must(p, "page").key.position)).toEqual([1, 2, 2]);
  expect(pages.map((p) => must(p, "page").rows[0]!.id)).toEqual(["event-0100", "event-0200", "event-0200"]);
});

// ---- S40: a page's own fault fails only that page --------------------------------------------------------------------------------------

/** 350 rows: the first 100 inline, then three stored pages of 100, 100 and 50 rows (positions 1, 2, 3). */
const worldOfThreePages = (): Promise<Env> => world(350);
const storedPageIds = (env: Env): string[] => JSON.parse(readFileSync(captureFile(env.session, "run-1", "inv-1"), "utf8")).views.find((candidate: any) => candidate.viewId === "watch.events").pages.map((page: any) => page.pageId);
const loadThreePages = async (env: Env) => must(await loadViewPages(env.session, { runId: "run-1", captureId: "inv-1", objectId: firstPage(env).objectId, viewId: "watch.events" }), "view");
const removePage = (env: Env, position: number): void => rmSync(pageFile(env.session, storedPageIds(env)[position - 1]!));
const firstRow = (page: Result<{ rows: Array<Record<string, unknown>> }>): unknown => (page.ok ? page.value.rows[0]!.id : `${page.error.code}: ${page.error.message}`);

// WHY CLAIM(S40): readPageAt's prefix chain returned the first failure for every later position, so one page removed from the store hid every page after
// it (pages 2 and 3 reported NOT_FOUND naming page 1's body). Rejects a chain that fails a page for the fault of an earlier one.
it("[S40] a missing page is the only page missing: the pages after it are served by the one reader", async () => {
  const env = await worldOfThreePages();
  const ids = storedPageIds(env);
  removePage(env, 1);
  const view = await loadThreePages(env);
  const pages = await Promise.all([readPageAt(view, 1), readPageAt(view, 2), readPageAt(view, 3)]);
  expect(pages.map((page) => (page.ok ? "ok" : page.error.code))).toEqual(["NOT_FOUND", "ok", "ok"]);
  expect(pages.slice(1).map(firstRow)).toEqual(["event-0200", "event-0300"]);
  expect(pages.slice(1).map((page) => must(page, "page").pageId)).toEqual([ids[1], ids[2]]);
  expect(JSON.stringify(pages[0])).toContain(ids[0]!);
  // uniqueness across the gap is not provable, and the page says so rather than claiming it
  expect(pages.slice(1).map((page) => must(page, "page").unprovenAgainst)).toEqual([[1], [1]]);
});

// WHY CLAIM(S40): the same verdict through V1Reader.page: position 3 used to return page 1's error.
it("[S40] V1Reader.page serves position 3 when page 1 is gone", async () => {
  const env = await worldOfThreePages();
  removePage(env, 1);
  const key = { runId: "run-1", captureId: "inv-1", objectId: firstPage(env).objectId, viewId: "watch.events" };
  const third = await openV1Reader(env.session).page({ ...key, position: 3 } as never);
  expect(firstRow(third)).toBe("event-0300");
  const first = await openV1Reader(env.session).page({ ...key, position: 1 } as never);
  expect(first.ok ? "ok" : first.error.code).toBe("NOT_FOUND");
});

// WHY CLAIM(S40): view_result and the viewer serve the rows they have and name only the gap that is there.
it.each(["the agent tool view_result", "the viewer's session source"] as const)("[S40] %s serves pages 2 and 3 and names only page 1 missing", async (surface) => {
  const env = await worldOfThreePages();
  const ids = storedPageIds(env);
  removePage(env, 1);
  let rows: number;
  let reason: string;
  if (surface === "the agent tool view_result") {
    const reply = await executeV1Operation({ session: env.session, sessionDir: env.dir, jobs: null }, "view_result", { run: "run-1", view: "watch.events", format: "json", maxBytes: 262_144 });
    expect(reply.ok, reply.body.slice(0, 300)).toBe(true);
    const body = JSON.parse(reply.body);
    rows = body.items.length;
    reason = JSON.stringify(body.completeness);
  } else {
    const entry = (await env.session.listViewIndex("snap-run-1")).find((candidate) => candidate.viewDefinitionId === "watch.events")!;
    const model = must(await createSessionSource(env.session).getView({ viewId: entry.viewId, snapshotId: "snap-run-1" }), "view");
    rows = (model.envelope.data as { rows: unknown[] }).rows.length;
    reason = JSON.stringify(model.envelope.completeness);
  }
  expect(rows, "100 inline rows + the 100 rows of page 2 + the 50 of page 3").toBe(250);
  expect(reason).toContain(ids[0]!);
  expect(reason).not.toContain(ids[1]!);
  expect(reason).not.toContain(ids[2]!);
  expect(reason).toContain("1 could not be read");
});

// WHY CLAIM(S40): uniqueness is checked against the pages that ARE present: a gap does not switch the check off for the pages after it.
it("[S40] a duplicate row id between two present pages is still corrupt when page 1 is gone", async () => {
  const env = await worldOfThreePages();
  removePage(env, 1);
  const view0 = await loadThreePages(env);
  const second = must(await readPageAt(view0, 2), "page 2");
  // page 3 repeats a row id of page 2
  const pageIds = storedPageIds(env);
  const rows = [{ ...GOOD_ROW, id: String(second.rows[0]!.id) }];
  const next = `sha256:${sha256(canonical(rows))}`;
  const file = captureFile(env.session, "run-1", "inv-1");
  const graph = JSON.parse(readFileSync(file, "utf8"));
  const view = graph.views.find((candidate: any) => candidate.viewId === "watch.events");
  view.pages[2] = { index: view.pages[2].index, pageId: next, rowCount: 1 };
  writeFileSync(file, JSON.stringify(graph));
  writeFileSync(pageFile(env.session, next), JSON.stringify({ pageId: next, rows }));
  const refs = join(runDirectory(env.session, "run-1"), "page-refs.json");
  writeFileSync(refs, readFileSync(refs, "utf8").replaceAll(pageIds[2]!, next).replace(/("pageId":"[^"]*"[^}]*?)"rowCount":50/, "$1\"rowCount\":1"));
  const view1 = await loadThreePages(env);
  const pages = await Promise.all([readPageAt(view1, 1), readPageAt(view1, 2), readPageAt(view1, 3)]);
  expect(pages.map((page) => (page.ok ? "ok" : page.error.code))).toEqual(["NOT_FOUND", "ok", "STORAGE_CORRUPT"]);
});

// WHY CLAIM(S40): only a page's OWN corruption fails it. Page 2 corrupt: page 1 and page 3 are served, page 2 is STORAGE_CORRUPT.
it("[S40] a corrupt page fails only itself", async () => {
  const env = await worldOfThreePages();
  const file = pageFile(env.session, storedPageIds(env)[1]!);
  const page = JSON.parse(readFileSync(file, "utf8"));
  page.rows[0].cells.event = "tampered";
  writeFileSync(file, JSON.stringify(page));
  const view = await loadThreePages(env);
  const pages = await Promise.all([readPageAt(view, 1), readPageAt(view, 2), readPageAt(view, 3)]);
  expect(pages.map((read) => (read.ok ? "ok" : read.error.code))).toEqual(["ok", "STORAGE_CORRUPT", "ok"]);
  expect(must(pages[2]!, "page 3").unprovenAgainst).toEqual([2]);
  expect(must(pages[0]!, "page 1").unprovenAgainst).toEqual([]);
});
