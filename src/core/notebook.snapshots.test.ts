// Review S4: notebook reads and updates picked "the last page with this pageId" across ALL snapshots, so the same pageId in two snapshots
// was confused (a read of snap-1 answered snap-2; an update meant for snap-1 wrote snap-2). Snapshot identity must travel with every notebook
// call: Session, the operations (CLI and MCP arguments), the viewer HTTP route and the viewer's own writes.
// Fixture: fixtures/components/all.bundle.json imported twice, as snap-1 and (inSnapshot) snap-2, so page "cancellation-notebook" exists in both
// with identical content; the tests tell the snapshots apart by what is written to one of them.
// Contract chosen (docs/design.md section 5 "Notebook storage"): `snapshotId` is optional when the pageId is unambiguous and REQUIRED (INVALID_ARGUMENT
// naming the snapshots) when several snapshots hold that pageId; an unknown snapshot is NOT_FOUND.
// proves: CLAIM(notebook-snapshot-identity)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeOperation } from "./operations.ts";
import { openSession, type Session } from "./session.ts";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { must } from "../../test/helpers/must.ts";
import { bundleFixture, inSnapshot } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { DIST_VIEWER, bearer, jsonOf, rawRequest, useViewers } from "../../test/helpers/wire-http.ts";

const PAGE = "cancellation-notebook";
const tmp = useTempDirs();
const viewers = useViewers();
const sessions: Session[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close().catch(() => {}); });

/** A session holding the fixture in snap-1 and snap-2: the notebook page exists once per snapshot, both at revision 1. */
async function twoSnapshots(dir = tmp("nb-snapshots")): Promise<{ dir: string; session: Session }> {
  const session = must(await openSession(dir));
  sessions.push(session);
  must(await session.importBundle(bundleFixture()));
  must(await session.importBundle(inSnapshot(bundleFixture(), "snap-2")));
  return { dir, session };
}
const blockIds = (page: { envelope: { data: unknown } }): string[] => (page.envelope.data as { blocks: Array<{ id: string }> }).blocks.map((block) => block.id);
const blocksOf = async (session: Session, snapshotId: string) => (must(await session.notebookGet(PAGE, undefined, snapshotId)).envelope.data as { blocks: unknown[] }).blocks;
/** The documented block order of the fixture is [b1, b2]; the edit used everywhere swaps it. */
const reversed = (blocks: unknown[]): unknown[] => [...blocks].reverse();

describe("[S4] Session addresses a notebook page by (pageId, snapshotId)", () => {
  it("a read names its snapshot: snap-1 answers snap-1 and snap-2 answers snap-2, each with its own revision history", async () => {
    const { session } = await twoSnapshots();
    must(await session.notebookUpdate(PAGE, 1, { blocks: reversed(await blocksOf(session, "snap-1")) }, "snap-1"));
    const first = must(await session.notebookGet(PAGE, undefined, "snap-1"));
    const second = must(await session.notebookGet(PAGE, undefined, "snap-2"));
    expect([first.snapshotId, first.envelope.snapshotId, first.revision, blockIds(first)]).toEqual(["snap-1", "snap-1", 2, ["b2", "b1"]]);
    expect([second.snapshotId, second.envelope.snapshotId, second.revision, blockIds(second)]).toEqual(["snap-2", "snap-2", 1, ["b1", "b2"]]);
    expect(blockIds(must(await session.notebookGet(PAGE, 1, "snap-1"))), "revision 1 of snap-1 is the original order").toEqual(["b1", "b2"]);
  });

  it("an update names its snapshot: only that snapshot's page and stored view change", async () => {
    const { session } = await twoSnapshots();
    const before = must(await session.getView({ viewId: PAGE, snapshotId: "snap-2" })).contentHash;
    const written = must(await session.notebookUpdate(PAGE, 1, { blocks: reversed(await blocksOf(session, "snap-1")) }, "snap-1"));
    expect([written.snapshotId, written.revision]).toEqual(["snap-1", 2]);
    expect(must(await session.getView({ viewId: PAGE, snapshotId: "snap-1" })).contentHash, "snap-1's stored view moved to the new revision").not.toBe(must(await session.getView({ viewId: PAGE, snapshotId: "snap-2" })).contentHash);
    expect(must(await session.getView({ viewId: PAGE, snapshotId: "snap-2" })).contentHash, "snap-2's stored view is untouched").toBe(before);
    expect(must(await session.notebookGet(PAGE, undefined, "snap-2")).revision).toBe(1);
  });

  it("an update with a stale revision for one snapshot is judged against THAT snapshot's revision", async () => {
    const { session } = await twoSnapshots();
    must(await session.notebookUpdate(PAGE, 1, { blocks: reversed(await blocksOf(session, "snap-1")) }, "snap-1")); // snap-1 is at 2, snap-2 still at 1
    const stale = await session.notebookUpdate(PAGE, 1, { blocks: await blocksOf(session, "snap-1") }, "snap-1");
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT", details: { currentRevision: 2 } } });
    expect(must(await session.notebookUpdate(PAGE, 1, { blocks: reversed(await blocksOf(session, "snap-2")) }, "snap-2")).revision, "snap-2 accepts revision 1").toBe(2);
  });

  it("without a snapshot, a pageId held by two snapshots is refused and nothing is written; an unknown snapshot is NOT_FOUND", async () => {
    const { session } = await twoSnapshots();
    const read = await session.notebookGet(PAGE);
    expect(read).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect(JSON.stringify(read)).toContain("snap-1");
    expect(JSON.stringify(read)).toContain("snap-2");
    const write = await session.notebookUpdate(PAGE, 1, { blocks: reversed(await blocksOf(session, "snap-1")) });
    expect(write).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect([must(await session.notebookGet(PAGE, undefined, "snap-1")).revision, must(await session.notebookGet(PAGE, undefined, "snap-2")).revision]).toEqual([1, 1]);
    expect(await session.notebookGet(PAGE, undefined, "snap-9")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  // control: the common single-snapshot case keeps working without naming the snapshot.
  it("control: with one snapshot the snapshot may be omitted", async () => {
    const session = must(await openSession(tmp("nb-one")));
    sessions.push(session);
    must(await session.importBundle(bundleFixture()));
    expect(must(await session.notebookGet(PAGE)).envelope.snapshotId).toBe("snap-1");
    expect(must(await session.notebookUpdate(PAGE, 1, { blocks: reversed(await blocksOf(session, "snap-1")) })).revision).toBe(2);
  });
});

describe("[S4] CLI and MCP arguments carry the snapshot", () => {
  it("notebook_get and notebook_update accept snapshotId and answer for that snapshot", async () => {
    const { session } = await twoSnapshots();
    const update = await executeOperation(session, "notebook_update", { pageId: PAGE, snapshotId: "snap-1", expectedRevision: 1, blocks: reversed(await blocksOf(session, "snap-1")), format: "json" });
    expect(update.ok, update.body).toBe(true);
    const first = JSON.parse((await executeOperation(session, "notebook_get", { pageId: PAGE, snapshotId: "snap-1", format: "json" })).body);
    const second = JSON.parse((await executeOperation(session, "notebook_get", { pageId: PAGE, snapshotId: "snap-2", format: "json" })).body);
    expect([first.view.snapshotId, first.revision, second.view.snapshotId, second.revision]).toEqual(["snap-1", 2, "snap-2", 1]);
    const ambiguous = await executeOperation(session, "notebook_get", { pageId: PAGE, format: "json" });
    expect(JSON.parse(ambiguous.body)).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("the CLI reads a page of one snapshot with --snapshot", async () => {
    const { dir, session } = await twoSnapshots();
    must(await session.notebookUpdate(PAGE, 1, { blocks: reversed(await blocksOf(session, "snap-1")) }, "snap-1"));
    const run = await runCliInProcess(["--session", dir, "notebook", "get", "--page", PAGE, "--snapshot", "snap-2", "--format", "json"]);
    expect(run.exitCode, run.stdout).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ view: { snapshotId: "snap-2" }, revision: 1 });
  });
});

describe("[S4] the viewer addresses pages by snapshot", () => {
  it("POST /api/notebooks/:id/revisions with snapshotId writes that snapshot only; /api/view reports each snapshot's own revision", async () => {
    const { server, session } = await viewers.start({}, {}, tmp("nb-http"));
    must(await session.importBundle(inSnapshot(bundleFixture(), "snap-2")));
    const blocks = reversed(await blocksOf(session, "snap-1"));
    const written = await rawRequest(server, `/api/notebooks/${PAGE}/revisions`, { method: "POST", headers: { ...bearer(server.token), "Content-Type": "application/json" }, body: JSON.stringify({ snapshotId: "snap-1", expectedRevision: 1, blocks }) });
    expect(written.status, written.text).toBe(200);
    expect(jsonOf(written)).toMatchObject({ snapshotId: "snap-1", revision: 2 });
    const revisionOf = async (snapshotId: string) => jsonOf(await rawRequest(server, `/api/view?viewId=${PAGE}&snapshotId=${snapshotId}`, { headers: bearer(server.token) })).notebookRevision;
    expect([await revisionOf("snap-1"), await revisionOf("snap-2")]).toEqual([2, 1]);
    const ambiguous = await rawRequest(server, `/api/notebooks/${PAGE}/revisions`, { method: "POST", headers: { ...bearer(server.token), "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 2, blocks }) });
    expect(ambiguous.status).toBe(400);
  });

  // why: the browser must send the snapshot it is showing. The SHIPPED bundle runs in JSDOM against the REAL server; the page open on snap-1
  //      is moved, and snap-2's page (same pageId) must still be at revision 1 with the original order.
  it("moving a block in the shipped viewer on snap-1 writes snap-1's page, not snap-2's", async () => {
    const { server, session } = await viewers.start({}, {}, tmp("nb-dom"));
    must(await session.importBundle(inSnapshot(bundleFixture(), "snap-2")));
    const html = readFileSync(join(DIST_VIEWER, "index.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
    const dom = new JSDOM(html, { url: `${server.origin}/#token=${server.token}&view=${PAGE}&snapshot=snap-1`, runScripts: "outside-only", pretendToBeVisual: true });
    (dom.window as unknown as { fetch: typeof fetch }).fetch = (input, init) => fetch(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, dom.window.location.href), init);
    dom.window.eval(readFileSync(join(DIST_VIEWER, "app.js"), "utf8"));
    try {
      const pw = (name: string): HTMLElement[] => Array.from(dom.window.document.querySelectorAll<HTMLElement>(`[data-pw="${name}"]`));
      await vi.waitFor(() => expect(pw("block").map((block) => block.getAttribute("data-id"))).toEqual(["b1", "b2"]), { timeout: 5000, interval: 20 });
      pw("block")[0]!.querySelector<HTMLElement>('[data-pw="block-move"][data-direction="down"]')!.click();
      await vi.waitFor(() => expect(pw("notebook-revision")[0]?.getAttribute("data-revision")).toBe("2"), { timeout: 5000, interval: 20 });
      const first = must(await session.notebookGet(PAGE, undefined, "snap-1"));
      const second = must(await session.notebookGet(PAGE, undefined, "snap-2"));
      expect([first.revision, blockIds(first)]).toEqual([2, ["b2", "b1"]]);
      expect([second.revision, blockIds(second)]).toEqual([1, ["b1", "b2"]]);
    } finally {
      dom.window.close();
    }
  });
});
