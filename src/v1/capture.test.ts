// Admission and lowering of SDK artifacts (IV1 host side, IV8, IV9, IV10 references): validateObjectGraph, entity mapping and
// lowerViewRecord. Every expectation is hand-written.
import { describe, expect, it } from "vitest";
import { validateSubmission } from "../core/validate.ts";
import { canonical, collectionFixture, sha256 } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { entityKindOf, entityOfObject, lowerViewRecord, objectContentHash, validateObjectGraph } from "./capture.ts";

const fixture = () => structuredClone(collectionFixture("vigil-redelivered").graphs[0]);

describe("[IV9] object graph admission", () => {
  // why: a fixture that is schema-valid and consistent must be admitted (positive control for every refusal below).
  // proves: CLAIM(IV9) CLAIM(IV8)
  it("admits a consistent graph of the expected run", () => {
    const graph = must(validateObjectGraph(fixture(), { expectedRunId: "run-1" }), "admit");
    expect(graph.objects).toHaveLength(4);
  });

  // why: IV8. A foreign or stale artifact (another run id) must never satisfy this run: no stale staging file from another run.
  // proves: CLAIM(IV8)
  it("refuses a graph whose run id is not the run being imported", () => {
    const error = mustFail(validateObjectGraph(fixture(), { expectedRunId: "run-OTHER" }), "foreign run");
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((e) => e.pointer)).toEqual(["/runId"]);
  });

  // why: each cross-reference must resolve: edge target, root, a view's object, a row target. The pointer says where.
  // proves: CLAIM(IV9)
  it.each([
    ["an edge target", (g: any) => void (g.objects[0].edges[0].target = "o99"), "/objects/0/edges/0/target"],
    ["a root", (g: any) => void (g.roots = ["o99"]), "/roots/0"],
    ["a view's object", (g: any) => void (g.views[0].objectId = "o99"), "/views/0/objectId"],
    ["a row target", (g: any) => void (g.views[1].data.rows[0].target = { object: "o99" }), "/views/1/data/rows/0/target/object"],
  ])("refuses a dangling %s", (_name, mutate, pointer) => {
    const graph = fixture();
    mutate(graph);
    const error = mustFail(validateObjectGraph(graph, { expectedRunId: "run-1" }), "dangling");
    expect(error.errors.map((e) => [e.code, e.pointer])).toContainEqual(["DANGLING_REFERENCE", pointer]);
  });

  // why: the content hash is part of the record; a record edited after hashing (a dropped event, a swapped field) must not pass.
  // proves: CLAIM(IV9) CLAIM(IV21)
  it("refuses an object whose content hash does not match its content", () => {
    const graph = fixture();
    graph.objects[1].fields.tick = 4;
    const error = mustFail(validateObjectGraph(graph, { expectedRunId: "run-1" }), "tampered");
    expect(error.errors.map((e) => e.pointer)).toContain("/objects/1/contentHash");
  });

  // why: a stored page is content addressed: pageId must be the sha256 of its canonical rows, or a page could be swapped silently.
  // proves: CLAIM(IV10)
  it("refuses a page whose id is not the hash of its rows", () => {
    const graph = fixture();
    const rows = [graph.views[1].data.rows[0]];
    graph.pages = [{ pageId: `sha256:${sha256(canonical(rows))}`, viewId: "watch.events", objectId: "o1", index: 1, rows }];
    graph.views[1].pages = [{ index: 1, pageId: graph.pages[0].pageId, rowCount: 1 }];
    must(validateObjectGraph(structuredClone(graph), { expectedRunId: "run-1" }), "positive control: a correct page id");
    graph.pages[0].pageId = `sha256:${"0".repeat(64)}`;
    graph.views[1].pages[0].pageId = graph.pages[0].pageId;
    const error = mustFail(validateObjectGraph(graph, { expectedRunId: "run-1" }), "wrong page id");
    expect(error.errors.map((e) => e.pointer)).toContain("/pages/0/pageId");
  });

  // why: spec section 4 limits are enforced on admission too (a hostile or buggy SDK): more objects than the stated limit is refused.
  // proves: CLAIM(IV9)
  it("refuses a graph that exceeds its own declared object limit", () => {
    const graph = fixture();
    graph.limits.objects = 3;
    const error = mustFail(validateObjectGraph(graph, { expectedRunId: "run-1" }), "over limit");
    expect(error.errors.map((e) => e.code)).toContain("LIMIT_EXCEEDED");
  });
});

describe("[IV11] entity mapping", () => {
  // why: type ids map to v0 entity kinds by a fixed rule (docs/v1-red-contract.md section 4); the table is hand-written.
  // proves: CLAIM(IV11)
  it.each([
    ["vigil::watch::WatchFile", "vigil/watch/watch-file"],
    ["containmarks::ContainerMappingRecord", "containmarks/container-mapping-record"],
    ["fx::Event", "fx/event"],
    ["vigil::watch::Event", "vigil/watch/event"],
  ])("%s -> %s", (typeId, kind) => {
    expect(entityKindOf(typeId)).toBe(kind);
  });

  // why: an object maps to an entity whose id carries the capture id (object ids repeat across captures), with the label of the record.
  // proves: CLAIM(IV11)
  it("an object becomes {repo, <captureId>.<objectId>, kind} with its label", () => {
    const entity = entityOfObject("vg", fixture(), "o3");
    expect(entity).toMatchObject({ repository: "vg", id: "inv-1.o3", kind: "vigil/watch/event", label: "e-2" });
  });

  // why: the content hash rule, computed here independently (canonical JSON of {domainKey, fields, label, typeId}).
  // proves: CLAIM(IV9)
  it("the content hash follows the stated rule", () => {
    const record = fixture().objects[1];
    expect(objectContentHash(record)).toBe(sha256(canonical({ typeId: record.typeId, domainKey: record.domainKey, label: record.label, fields: record.fields })));
  });
});

describe("[IV1] lowering a view record to a v0 envelope", () => {
  const context = { repo: "cm", snapshotId: "snap-run-2", runnerId: "vitest", startedAt: "2026-11-11T12:00:00Z", finishedAt: "2026-11-11T12:00:01Z", generatedAt: "2026-11-11T12:00:02Z" };

  // why: IV1/IV8. The mapping.details view becomes an ordinary paneweft.view/1 envelope that the v0 validator accepts: a run source with
  // the real run id, `observed` items citing it, the stored view id `<captureId>.<objectId>.<viewId>`, the entity of the object.
  // The expected values are the hand-written ones from the ContainMarks question.
  // proves: CLAIM(IV1) CLAIM(IV8)
  it("produces a valid envelope with a run source and observed items", () => {
    const graph = collectionFixture("containmarks-mapping").graphs[0];
    const lowered = must(lowerViewRecord(graph, graph.views[0], context), "lower");
    const envelope = lowered.envelope as any;
    expect(envelope).toMatchObject({ schemaVersion: "paneweft.view/1", id: "inv-1.o1.mapping.details", title: "Container mapping", question: "Which original index and container does this mapping preserve?", component: "shape", snapshotId: "snap-run-2", viewDefinitionId: "mapping.details", entity: { repository: "cm", id: "inv-1.o1", kind: "containmarks/container-mapping-record" }, completeness: { status: "complete" } });
    expect(envelope.sources).toEqual([{ id: "run", kind: "run", run_id: "run-2", runner_id: "vitest", started_at: "2026-11-11T12:00:00Z", finished_at: "2026-11-11T12:00:01Z" }]);
    expect(envelope.data.fields.map((f: any) => [f.path, f.example, f.provenance, f.evidence])).toEqual([["$", undefined, "observed", ["run"]], ["$.original index", 4, "observed", ["run"]], ["$.container ID", "firefox-container-3", "observed", ["run"]], ["$.backup name", "Work", "observed", ["run"]]]);
    expect(lowered.definition).toMatchObject({ id: "mapping.details", entityKind: "containmarks/container-mapping-record", component: "shape", title: "Container mapping" });
    const checked = validateSubmission(envelope);
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
  });

  // why: a list view's row `target` becomes the row's `entity`, the exact object of the same capture: this is how selection reaches
  // the corresponding event and not a same-looking row elsewhere (IV11, IV21).
  // proves: CLAIM(IV11) CLAIM(IV21)
  it("lowers row targets to entities of the same capture", () => {
    const graph = collectionFixture("vigil-redelivered").graphs[0];
    const lowered = must(lowerViewRecord(graph, graph.views[1], { ...context, repo: "vg", snapshotId: "snap-run-1" }), "lower");
    const rows = (lowered.envelope as any).data.rows;
    expect(rows.map((r: any) => [r.id, r.entity.id, r.entity.kind])).toEqual([["event-0", "inv-1.o2", "vigil/watch/event"], ["event-2", "inv-1.o4", "vigil/watch/event"], ["event-1", "inv-1.o3", "vigil/watch/event"]]);
    expect(rows.every((r: any) => r.target === undefined), "the SDK-only member is gone from the stored row").toBe(true);
  });
});
