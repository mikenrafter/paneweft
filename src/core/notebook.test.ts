// Notebook pages in the session store (design 2.6, 5; MC16): revisions, conflicts, failed saves,
// evidence preservation, export/import and restart. The demo page is the design section 6 page
// (claims D1/D2/D3) written as a literal in test/helpers/store-notebook.ts.
// Decisions on questions the design leaves open (page id = envelope id, replace semantics, ...) are in
// docs/contract-additions/store.md and cited in the why comments.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Envelope } from "./wire.ts";
import type { SessionOptions } from "./session.ts";
import { patch } from "../../test/helpers/patch.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { PAGE_ID, demoBlocks, demoNotebook, type Block } from "../../test/helpers/store-notebook.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const fresh = () => join(tmp("notebook"), "s");
const blockIds = (envelope: Envelope) => (envelope.data as { blocks: Block[] }).blocks.map((block) => block.id);

/** A session with the fixture bundle imported (entity notes/page and def-story exist) and the demo page created. */
async function sessionWithPage(dir = fresh(), options?: SessionOptions) {
  const session = await openOk(dir, options);
  await importAll(session);
  must(await session.notebookCreate(demoNotebook()));
  return { dir, session };
}
/** The demo blocks with D3's statement replaced; each racer uses its own statement so contents differ. */
const racerBlocks = (label: string): Block[] =>
  demoBlocks().map((block) => (block.id === "D3" ? { ...block, statement: `Racer ${label} claims the checkout works.` } : block));

describe("Notebook create and get", () => {
  // why: MC16: ordered claims and references must come back exactly. Create returns revision 1 and the
  //   stored envelope equals the input, with block order preserved.
  // proves: CLAIM(MC16)
  it("[MC16] notebookCreate returns revision 1 and notebookGet returns the envelope deep-equal to the input", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    const created = must(await session.notebookCreate(demoNotebook()));
    expect(created.pageId).toBe(PAGE_ID);
    expect(created.revision).toBe(1);
    expect(created.envelope).toEqual(demoNotebook());
    expect(must(await session.notebookGet(PAGE_ID))).toEqual(created);
  });

  // why: design 4: supports/contradicts reference source ids or {viewId,itemId}, "never ambiguous bare item
  //   ids". The object form must round-trip with both keys, and block order is the submitted order.
  // proves: CLAIM(MC16)
  it("[MC16] the stored page keeps block order (intro, v1, v2, D1, r1, D2, ex1, D3) and D1's mixed evidence targets", async () => {
    const { session } = await sessionWithPage();
    const page = must(await session.notebookGet(PAGE_ID));
    expect(blockIds(page.envelope)).toEqual(["intro", "v1", "v2", "D1", "r1", "D2", "ex1", "D3"]);
    const d1 = (page.envelope.data as { blocks: Block[] }).blocks.find((block) => block.id === "D1")!;
    expect(d1.supports).toEqual(["sv", { viewId: "delivery-path", itemId: "e" }]);
    expect(d1.status).toBe("supported");
    const d3 = (page.envelope.data as { blocks: Block[] }).blocks.find((block) => block.id === "D3")!;
    expect([d3.status, d3.supports, d3.contradicts]).toEqual(["open", [], []]);
  });

  // why: a page that does not exist is NOT_FOUND, and so is a revision that was never created.
  // proves: CLAIM(MC16)
  it("[MC16] unknown page and unknown revision are NOT_FOUND", async () => {
    const { session } = await sessionWithPage();
    expect(mustFail(await session.notebookGet("no-such-page")).code).toBe("NOT_FOUND");
    expect(mustFail(await session.notebookGet(PAGE_ID, 2)).code).toBe("NOT_FOUND");
    expect(mustFail(await session.notebookUpdate("no-such-page", 1, { blocks: demoBlocks() })).code).toBe("NOT_FOUND");
  });
});

describe("Notebook update creates a new revision", () => {
  // why: design 2.6: "Notebook editing creates a new page revision." Update at revision 1 -> revision 2
  //   with the new blocks; revision 1 stays retrievable and exactly as created (history is immutable).
  // proves: CLAIM(MC16)
  it("[MC16] update with expectedRevision 1 -> revision 2; get(pageId, 1) still returns revision 1 exactly", async () => {
    const { session } = await sessionWithPage();
    const original = must(await session.notebookGet(PAGE_ID));
    const updated = must(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") }));
    expect(updated.revision).toBe(2);
    expect(updated.pageId).toBe(PAGE_ID);
    expect((updated.envelope.data as { blocks: Block[] }).blocks).toEqual(racerBlocks("A"));
    expect(must(await session.notebookGet(PAGE_ID, 1))).toEqual(original);
    expect(must(await session.notebookGet(PAGE_ID, 2))).toEqual(updated);
    expect(must(await session.notebookGet(PAGE_ID))).toEqual(updated); // latest is revision 2
  });

  // why: update replaces ordered blocks only (store.md#8); every other envelope field - id, title, entity,
  //   scope, sources when omitted - is carried over unchanged.
  // proves: CLAIM(MC16)
  it("[MC16] an update that omits sources keeps id, title, entity, scope, sources and freshness", async () => {
    const { session } = await sessionWithPage();
    const updated = must(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") }));
    const { data: _data, ...rest } = updated.envelope;
    const { data: _original, ...restOriginal } = demoNotebook();
    expect(rest).toEqual(restOriginal);
  });

  // why: MC16 + design 6: "If a future run contradicts a claim, keep the old evidence and mark the claim
  //   disputed." The update API accepts a status change; the claim keeps its supports, gains contradicts.
  //   The old revision still shows the claim as supported.
  // proves: CLAIM(MC16)
  it("[MC16] marking D1 disputed keeps its supports and records the contradiction; revision 1 still says supported", async () => {
    const { session } = await sessionWithPage();
    const blocks = demoBlocks().map((block) =>
      block.id === "D1" ? { ...block, status: "disputed", contradicts: [{ viewId: "vigil-one-write", itemId: "once" }] } : block);
    const updated = must(await session.notebookUpdate(PAGE_ID, 1, { blocks }));
    const d1 = (updated.envelope.data as { blocks: Block[] }).blocks.find((block) => block.id === "D1")!;
    expect(d1.status).toBe("disputed");
    expect(d1.supports).toEqual(["sv", { viewId: "delivery-path", itemId: "e" }]);
    expect(d1.contradicts).toEqual([{ viewId: "vigil-one-write", itemId: "once" }]);
    const old = must(await session.notebookGet(PAGE_ID, 1));
    const oldD1 = (old.envelope.data as { blocks: Block[] }).blocks.find((block) => block.id === "D1")!;
    expect([oldD1.status, oldD1.contradicts]).toEqual(["supported", []]);
  });

  // why: "reorder blocks" is a notebook interaction (design 2.6); the submitted order is the stored order.
  // proves: CLAIM(MC16)
  it("[MC16] reordering the blocks in an update is stored in the new order", async () => {
    const { session } = await sessionWithPage();
    const reversed = demoBlocks().reverse();
    const updated = must(await session.notebookUpdate(PAGE_ID, 1, { blocks: reversed }));
    expect(blockIds(updated.envelope)).toEqual(["D3", "ex1", "D2", "r1", "D1", "v2", "v1", "intro"]);
  });

  // why: positive control for the dangling-source rejection below: an update may add a source and use it.
  // proves: CLAIM(MC16)
  it("[MC16] an update that adds source s9 and a block citing it is accepted", async () => {
    const { session } = await sessionWithPage();
    const s9 = { id: "s9", kind: "file", repository: "r", path: "src/mcp.rs", sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03", capturedAt: "2026-11-11T00:00:00Z", method: "read" };
    const blocks = [...demoBlocks(), { id: "n9", kind: "prose", markdown: "A late note.", provenance: "read", evidence: ["s9"] }];
    const updated = must(await session.notebookUpdate(PAGE_ID, 1, { blocks, sources: [...demoNotebook().sources, s9] }));
    expect(updated.revision).toBe(2);
    expect(updated.envelope.sources.map((source) => source.id)).toEqual(["sv", "sr", "sd", "s9"]);
    expect(blockIds(updated.envelope)).toEqual(["intro", "v1", "v2", "D1", "r1", "D2", "ex1", "D3", "n9"]);
  });

  // why: MC16: an update whose blocks cite a source id that does not exist is rejected as VALIDATION_FAILED
  //   with the pointer into the would-be page, and creates NO revision.
  // proves: CLAIM(MC16)
  it("[MC16] a block citing a missing source id: VALIDATION_FAILED at /data/blocks/3/evidence/0, no revision 2", async () => {
    const { session } = await sessionWithPage();
    const blocks = patch({ blocks: demoBlocks() }, { op: "replace", path: "/blocks/3/evidence/0", value: "s-missing" }).blocks;
    const error = mustFail(await session.notebookUpdate(PAGE_ID, 1, { blocks }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["DANGLING_REFERENCE", "/data/blocks/3/evidence/0"]]);
    expect(mustFail(await session.notebookGet(PAGE_ID, 2)).code).toBe("NOT_FOUND");
    expect(must(await session.notebookGet(PAGE_ID)).revision).toBe(1);
  });

  // why: shape faults are rejected by the same gate: an unknown block kind is ENUM at the kind, no revision.
  // proves: CLAIM(MC16)
  it("[MC16] a block with an unknown kind: VALIDATION_FAILED (ENUM at /data/blocks/0/kind), no revision 2", async () => {
    const { session } = await sessionWithPage();
    const blocks = patch({ blocks: demoBlocks() }, { op: "replace", path: "/blocks/0/kind", value: "diagram" }).blocks;
    const error = mustFail(await session.notebookUpdate(PAGE_ID, 1, { blocks }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["ENUM", "/data/blocks/0/kind"]]);
    expect(must(await session.notebookGet(PAGE_ID)).revision).toBe(1);
  });
});

describe("Notebook conflicts", () => {
  // why: optimistic concurrency, sequential form: updating from revision 1 after revision 2 exists is a
  //   retryable CONFLICT that names the current revision; the page does not move.
  // proves: CLAIM(MC16)
  it("[MC16] a stale expectedRevision is a retryable CONFLICT with details.currentRevision 2", async () => {
    const { session } = await sessionWithPage();
    must(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") }));
    const error = mustFail(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("B") }));
    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ currentRevision: 2 });
    expect(must(await session.notebookGet(PAGE_ID)).revision).toBe(2);
    expect(must(await session.notebookUpdate(PAGE_ID, 2, { blocks: racerBlocks("B") })).revision).toBe(3); // retry after re-read
  });

  // why: MC16: "Two updates from one revision yield one success and one conflict." Raced with Promise.all on
  //   two separate handles over the same directory (two processes in production).
  // proves: CLAIM(MC16)
  it("[MC16] two updates from revision 1 raced on two Session handles: exactly one ok and one CONFLICT (currentRevision 2)", async () => {
    const { dir } = await sessionWithPage();
    const a = await openOk(dir);
    const b = await openOk(dir);
    const results = await Promise.all([
      a.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") }),
      b.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("B") }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
    expect(failures.map((error) => [error.code, error.retryable, error.details])).toEqual([["CONFLICT", true, { currentRevision: 2 }]]);
    const winner = results.findIndex((result) => result.ok) === 0 ? "A" : "B";
    const latest = must(await (await openOk(dir)).notebookGet(PAGE_ID));
    expect(latest.revision).toBe(2);
    expect((latest.envelope.data as { blocks: Block[] }).blocks).toEqual(racerBlocks(winner));
  });

  // why: heavier contention: five handles at once. Still exactly one winner, four conflicts, revision 2.
  // proves: CLAIM(MC16)
  it("[MC16] five handles racing from revision 1: one ok, four CONFLICT, and the page is at revision 2", async () => {
    const { dir } = await sessionWithPage();
    const labels = ["A", "B", "C", "D", "E"];
    const handles = await Promise.all(labels.map(() => openOk(dir)));
    const results = await Promise.all(handles.map((handle, index) => handle.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks(labels[index]!) })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
    expect(failures.map((error) => [error.code, error.retryable, error.details])).toEqual(
      [0, 1, 2, 3].map(() => ["CONFLICT", true, { currentRevision: 2 }]),
    );
    expect(must(await (await openOk(dir)).notebookGet(PAGE_ID)).revision).toBe(2);
    expect(mustFail(await (await openOk(dir)).notebookGet(PAGE_ID, 3)).code).toBe("NOT_FOUND");
  });
});

describe("Notebook failed saves", () => {
  // why: MC16: "Inject a failed save and prove the prior revision still opens." STORAGE_FAILED, the previous
  //   revision intact and still the latest, revision 2 absent, and a retry succeeds as revision 2.
  // proves: CLAIM(MC16)
  it("[MC16] a failing manifest swap on update: STORAGE_FAILED, revision 1 intact and latest, retry becomes revision 2", async () => {
    let armed = false;
    const { session } = await sessionWithPage(fresh(), { testHooks: { beforeManifestSwap: () => { if (armed) throw new Error("simulated crash"); } } });
    const before = must(await session.notebookGet(PAGE_ID));
    armed = true;
    expect(mustFail(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") })).code).toBe("STORAGE_FAILED");
    expect(must(await session.notebookGet(PAGE_ID))).toEqual(before);
    expect(mustFail(await session.notebookGet(PAGE_ID, 2)).code).toBe("NOT_FOUND");
    armed = false;
    const retry = must(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") }));
    expect(retry.revision).toBe(2);
    expect(must(await session.notebookGet(PAGE_ID, 1))).toEqual(before);
  });

  // why: a failed FIRST save must not leave a page behind either; the retry creates revision 1.
  // proves: CLAIM(MC16)
  it("[MC16] a failing manifest swap on create: STORAGE_FAILED, no page, retry creates revision 1", async () => {
    let armed = false;
    const session = await openOk(fresh(), { testHooks: { beforeManifestSwap: () => { if (armed) throw new Error("simulated crash"); } } });
    await importAll(session);
    armed = true;
    expect(mustFail(await session.notebookCreate(demoNotebook())).code).toBe("STORAGE_FAILED");
    expect(mustFail(await session.notebookGet(PAGE_ID)).code).toBe("NOT_FOUND");
    armed = false;
    expect(must(await session.notebookCreate(demoNotebook())).revision).toBe(1);
  });

  // why: the injected failure may strike while staging files (second write): the visible state is still the
  //   previous revision, also for a reopened session.
  // proves: CLAIM(MC16)
  it("[MC16] a failing file write during update leaves revision 1 readable after reopening", async () => {
    const dir = fresh();
    let armed = false;
    const { session } = await sessionWithPage(dir, { testHooks: { afterWrite: ({ count }) => { if (armed && count === 1) throw new Error("simulated write failure"); } } });
    const before = must(await session.notebookGet(PAGE_ID));
    armed = true;
    expect(mustFail(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") })).code).toBe("STORAGE_FAILED");
    await session.close();
    const reopened = await openOk(dir);
    expect(must(await reopened.notebookGet(PAGE_ID))).toEqual(before);
    expect(mustFail(await reopened.notebookGet(PAGE_ID, 2)).code).toBe("NOT_FOUND");
  });
});

describe("Notebook export, import and restart", () => {
  // why: MC16: "Import/export a page ... compare exact content." The latest revision of a page is exported as
  //   a notebook view named by the page id (store.md#9); importing that bundle into a fresh session
  //   reproduces the page envelope exactly.
  // proves: CLAIM(MC16)
  it("[MC16] exportBundle carries the latest page envelope; a fresh session importing it has an equal notebookGet", async () => {
    const { session } = await sessionWithPage();
    const updated = must(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") }));
    const exported = await session.exportBundle();
    expect(exported.views.find((view) => view.id === PAGE_ID)).toEqual(updated.envelope);

    const other = await openOk(fresh());
    must(await other.importBundle(exported));
    expect(must(await other.notebookGet(PAGE_ID)).envelope).toEqual(updated.envelope);
  });

  // why: MC16: "restart the process, and compare exact content". Both revisions survive close + reopen.
  // proves: CLAIM(MC16)
  it("[MC16] after close and openSession both revisions read back equal, and revision numbering continues", async () => {
    const { dir, session } = await sessionWithPage();
    const first = must(await session.notebookGet(PAGE_ID));
    const second = must(await session.notebookUpdate(PAGE_ID, 1, { blocks: racerBlocks("A") }));
    await session.close();
    const reopened = await openOk(dir);
    expect(must(await reopened.notebookGet(PAGE_ID, 1))).toEqual(first);
    expect(must(await reopened.notebookGet(PAGE_ID, 2))).toEqual(second);
    expect(must(await reopened.notebookGet(PAGE_ID))).toEqual(second);
    expect(must(await reopened.notebookUpdate(PAGE_ID, 2, { blocks: racerBlocks("B") })).revision).toBe(3);
  });
});
