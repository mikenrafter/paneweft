// The agent tools through the shared handler (IV14, IV15, IV19, S12): discovery that never executes code and never asserts absence,
// read-only scaffolding, collection through the job service, result and failure reads, byte budgets and cursors. CLI/MCP parity is in
// test/v1/surface.test.ts.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FIXTURES, REPO_ROOT, collectionImport, fakeCargoAdapter, git, loadFixture, makeRepo, useFakeQex, useV1Sessions, write } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { independentFingerprint, makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { importCollection } from "./import.ts";
import { createJobService } from "./jobs.ts";
import { V1_TOOL_NAMES } from "./schemas.ts";
import { executeV1Operation, v1ToolDescriptors, type V1Context } from "./tools.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const catalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");

const toolWorld = makeToolWorld({ open, tmp, fake });

describe("[IV14] discovery", () => {
  // why: IV14. The ten tools are advertised with the descriptors the schemas define; discovery tools say they execute nothing.
  // proves: CLAIM(IV14) CLAIM(S1-week-one-cut)
  it("advertises the ten tools with their schemas and honest descriptions", () => {
    const tools = v1ToolDescriptors();
    expect(tools.map((t) => t.name).sort()).toEqual([...V1_TOOL_NAMES].sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["list_types", "list_views_for_type", "list_examples"]) expect(byName[name]!.description).toMatch(/never executes code/);
    expect(byName.collect!.description).toMatch(/EXECUTES CODE/);
    expect(byName.scaffold_view!.description).toMatch(/writes nothing/);
  });

  // why: IV14. list_types returns the catalogue's types with their views and examples, the catalogue digest, the target/feature scope
  // and a fresh freshness verdict computed from the REAL files of the registered root.
  // proves: CLAIM(IV14)
  it("lists types with views, examples, digest, scope and freshness", async () => {
    const { okCall } = await toolWorld();
    const { payload } = await okCall("list_types", { repo: "vg" });
    expect(payload).toMatchObject({ schemaVersion: "paneweft.reply/2", tool: "list_types", completeness: { status: "complete" }, freshness: { status: "fresh", catalogueDigest: catalogue.digest }, counts: { unit: "types", total: 2, matched: 2, returned: 2, omitted: 0, truncated: false }, cursor: null });
    expect(payload.items).toEqual([
      { typeId: "vigil::watch::Event", source: { path: "src/watch.rs", symbol: "Event" }, views: ["event.details"], examples: [] },
      { typeId: "vigil::watch::WatchFile", source: { path: "src/watch.rs", symbol: "WatchFile" }, views: ["watch.events", "watch.status"], examples: ["watch.cancelled", "watch.pending", "watch.redelivered"] },
    ]);
    expect(payload.details.target).toEqual(catalogue.target);
    expect(payload.details.linkedScope).toEqual(["watchfile (lib)"]);
  });

  // why: IV14 / S12 text form: the same facts in the text grammar of the contract (header, then one line per type).
  // proves: CLAIM(IV14) CLAIM(IV19)
  it("text form carries the header and one line per type", async () => {
    const { text } = await toolWorld();
    const outcome = await text("list_types", { repo: "vg" });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    const lines = outcome.body.split("\n");
    expect(lines[0]).toBe("paneweft.reply/2 tool=list_types");
    expect(lines).toContain("completeness: complete");
    expect(lines).toContain(`freshness: fresh (catalogue ${catalogue.digest})`);
    expect(lines).toContain("counts: unit=types total=2 matched=2 returned=2 omitted=0 truncated=false");
    expect(lines).toContain("vigil::watch::WatchFile -> src/watch.rs:WatchFile; views=watch.events,watch.status; examples=watch.cancelled,watch.pending,watch.redelivered");
    expect(lines).toContain("vigil::watch::Event -> src/watch.rs:Event; views=event.details; examples=none");
  });

  // why: IV14. A source edit after the catalogue was compiled makes it stale WITH the changed paths; the verdict is never "fresh".
  // proves: CLAIM(IV14) CLAIM(IV18)
  it("reports a stale catalogue with the changed files", async () => {
    const { okCall } = await toolWorld({ stale: true });
    const { payload } = await okCall("list_types", { repo: "vg" });
    expect(payload.freshness.status).toBe("stale");
    expect(payload.freshness.reasons).toContain("src/lib.rs: modified");
  });

  // why: IV14. Without a registered root freshness is `unverified` and says how to register it; stale metadata stays readable.
  // proves: CLAIM(IV14)
  it("is unverified when the repository root is not registered", async () => {
    const { okCall } = await toolWorld({ registerRoot: false });
    const { payload } = await okCall("list_types", { repo: "vg" });
    expect(payload.freshness.status).toBe("unverified");
    expect(payload.freshness.reasons.join(" ")).toContain("paneweft repo add");
  });

  // why: IV14. A type missing from the catalogue is NOT a statement that no view exists: the reply is ok, partial, empty, and the
  // notice names the linked scope; on a stale catalogue it also says the catalogue is outdated.
  // proves: CLAIM(IV14)
  it.each([[false, "linked scope"], [true, "outdated"]])("an unknown type never asserts absence (stale=%s)", async (stale, phrase) => {
    const { call } = await toolWorld({ stale });
    const { outcome, payload } = await call("list_views_for_type", { repo: "vg", type: "vigil::watch::Missing" });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(payload.items).toEqual([]);
    expect(payload.completeness.status).toBe("partial");
    expect(payload.notices.join(" ")).toContain(phrase);
    expect(payload.notices.join(" ")).not.toMatch(/no view exists|there is no view/i);
  });

  // why: IV14. views for a type: definitions in priority order with source locations, the examples that return the type and the last
  // capture (null until something was collected).
  // proves: CLAIM(IV14)
  it("lists the views of a type with sources and example links", async () => {
    const { okCall } = await toolWorld();
    const { payload } = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    expect(payload.items).toEqual([
      { id: "watch.status", title: "Status", question: "What state did this watch reach?", component: "shape", priority: 10, source: { path: "src/watch.rs", line: 41 }, renderer: null, exampleIds: ["watch.cancelled", "watch.pending", "watch.redelivered"], lastCapture: null, staleReasons: [] },
      { id: "watch.events", title: "Events", question: "Which events were retained, and were they redelivered?", component: "list", priority: 20, source: { path: "src/watch.rs", line: 58 }, renderer: null, exampleIds: ["watch.cancelled", "watch.pending", "watch.redelivered"], lastCapture: null, staleReasons: [] },
    ]);
  });

  // why: IV14. examples: ids, return types, claims, kind, selector, composition links and last outcomes (null when never run).
  // proves: CLAIM(IV14)
  it("lists examples with claims, selectors and last outcomes", async () => {
    const { okCall } = await toolWorld();
    const { payload } = await okCall("list_examples", { repo: "vg", type: "vigil::watch::WatchFile" });
    expect(payload.items.map((e: any) => e.id)).toEqual(["watch.cancelled", "watch.pending", "watch.redelivered"]);
    expect(payload.items[1]).toEqual({ id: "watch.pending", returns: "vigil::watch::WatchFile", claims: ["VW1"], kind: "example", selector: { runner: "cargo", name: "tests::paneweft_example_watch_pending", package: "watchfile", target: "lib" }, composes: [], lastOutcome: null });
  });

  // why: IV14. Discovery executes nothing and writes nothing: no qex call, no new file in the session or the repository.
  // proves: CLAIM(IV14) CLAIM(IV15)
  it("discovery calls leave qex and the repository untouched", async () => {
    const { okCall, qex, root, dir } = await toolWorld();
    const before = { repo: git(root, "status", "--porcelain"), session: readdirSync(dir).sort() };
    for (const [tool, args] of [["list_types", { repo: "vg" }], ["list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" }], ["list_examples", { repo: "vg" }]] as const) await okCall(tool, args);
    expect(qex.calls()).toEqual([]);
    expect({ repo: git(root, "status", "--porcelain"), session: readdirSync(dir).sort() }).toEqual(before);
  });
});

describe("[IV15] scaffold_view", () => {
  // why: IV15. The scaffold writes NOTHING, names the type and the question, gives a view that is `unsupported` with a TODO reason (no
  // invented fields: no field of WatchFile appears), an output test that fails on an assertion, the registration change and the collect recipe.
  // proves: CLAIM(IV15)
  it("returns a patch, a failing output test and a recipe without writing or inventing", async () => {
    const { call, root } = await toolWorld();
    const before = git(root, "status", "--porcelain");
    const { outcome, payload } = await call("scaffold_view", { repo: "vg", type: "vigil::watch::WatchFile", question: "Which events survive a cancel?", maxBytes: 32768 });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe(before);
    const patch = payload.details.patches.map((p: any) => p.text).join("\n");
    expect(patch).toContain("vigil::watch::WatchFile");
    expect(patch).toContain("Which events survive a cancel?");
    expect(patch).toMatch(/unsupported\(.*TODO/s);
    for (const invented of ["tick", "event_id", "judge_status", "redelivered"]) expect(patch, `invented field ${invented}`).not.toContain(invented);
    expect(payload.details.outputTest.text).toMatch(/assert/);
    expect(payload.details.outputTest.text).toContain("TODO");
    expect(payload.details.recipe).toEqual({ command: "paneweft collect --request-id <id> --repo vg --adapter cargo --example <example-id>", adapter: "cargo" });
    expect(payload.details.registration).toBeTruthy();
  });

  // why: IV15. A patch larger than the requested budget is returned as separate parts with a cursor, never as a clipped patch that looks
  // complete; following the cursor reproduces exactly the patch of a large budget.
  // proves: CLAIM(IV15) CLAIM(IV19)
  it("pages a large patch instead of clipping it", async () => {
    const { call, okCall } = await toolWorld();
    const full = await okCall("scaffold_view", { repo: "vg", type: "vigil::watch::WatchFile", question: "Q?", maxBytes: 32768 });
    const fullText = full.payload.details.patches.map((p: any) => p.text).join("");
    const parts: string[] = [];
    const outputTest: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page = await okCall("scaffold_view", { repo: "vg", type: "vigil::watch::WatchFile", question: "Q?", maxBytes: 2048, ...(cursor ? { cursor } : {}) });
      expect(page.outcome.ok, page.outcome.body.slice(0, 200)).toBe(true);
      expect(Buffer.byteLength(page.outcome.body)).toBeLessThanOrEqual(2048);
      for (const patch of page.payload.details.patches) { expect(patch.part).toBeDefined(); expect(patch.ofParts).toBeGreaterThan(1); (patch.role === "output-test" ? outputTest : parts).push(patch.text); }
      cursor = page.payload.cursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(parts.join("")).toBe(fullText);
    // the output test of a real scaffold does not fit beside the header at the smallest budget: a paged walk delivers it as the last file
    expect(outputTest.join("")).toBe(full.payload.details.outputTest.text);
  });

  // why: IV15. A bare symbol that several catalogued types share requires disambiguation: the error lists the candidate type ids and
  // source locations, never picks one.
  // proves: CLAIM(IV15)
  it("an ambiguous symbol lists candidates", async () => {
    const world = await toolWorld();
    const ambiguous = structuredClone(catalogue);
    ambiguous.types.push({ typeId: "other::Event", source: { path: "src/other.rs", symbol: "Event" } });
    const record = JSON.parse(readFileSync(join(world.dir, "catalogues", "vg", "cargo.json"), "utf8"));
    writeFileSync(join(world.dir, "catalogues", "vg", "cargo.json"), JSON.stringify({ ...record, catalogue: ambiguous }));
    const { outcome, payload } = await world.call("scaffold_view", { repo: "vg", type: "Event", question: "Q?" });
    expect(outcome.ok).toBe(false);
    expect(payload.code).toBe("UNRESOLVED_TARGET");
    expect(payload.details.candidates).toEqual([{ typeId: "other::Event", source: { path: "src/other.rs", symbol: "Event" } }, { typeId: "vigil::watch::Event", source: { path: "src/watch.rs", symbol: "Event" } }]);
  });

  // why: IV15. An explicit source path and symbol is accepted as a CANDIDATE for a type not yet catalogued, with the note that the
  // compiler must validate it; the reply still writes nothing.
  // proves: CLAIM(IV15)
  it("accepts an explicit source candidate for an uncatalogued type", async () => {
    const { call } = await toolWorld();
    const { outcome, payload } = await call("scaffold_view", { repo: "vg", type: "vigil::watch::Brand", question: "Q?", source: { path: "src/watch.rs", symbol: "Brand" } });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(payload.notices.join(" ")).toContain("candidate");
    expect(payload.notices.join(" ")).toContain("compiler");
  });
});

describe("[IV16][IV17] collect, status, cancel through the tools", () => {
  // why: the collect tool is a thin adapter over the job service: same job, same ids; an unregistered adapter is refused with the
  // setup command; unknown request members are refused.
  // proves: CLAIM(IV16) CLAIM(IV19)
  it("starts a durable job and reports it", async () => {
    const { call } = await toolWorld();
    const started = await call("collect", { requestId: "tool-1", repo: "vg", adapter: "cargo", examples: ["watch.pending"] });
    expect(started.outcome.ok, started.outcome.body.slice(0, 300)).toBe(true);
    expect(started.payload.items[0]).toMatchObject({ requestId: "tool-1", runId: "run-tool-1", created: true });
    const again = await call("collect", { requestId: "tool-1", repo: "vg", adapter: "cargo", examples: ["watch.pending"] });
    expect(again.payload.items[0]).toMatchObject({ requestId: "tool-1", created: false });
    const status = await vi.waitFor(async () => { const s = await call("collection_status", { job: "tool-1" }); expect(s.payload.items[0].state).toBe("succeeded"); return s; }, { timeout: 20_000, interval: 50 });
    expect(status.payload.items[0].snapshotIds).toEqual(["snap-run-tool-1"]);
    const refused = await call("collect", { requestId: "tool-2", repo: "vg", adapter: "ghost", examples: ["watch.pending"] });
    expect(refused.payload.code).toBe("NOT_FOUND");
    const forbidden = await call("collect", { requestId: "tool-3", repo: "vg", adapter: "cargo", examples: ["watch.pending"], argv: ["--nocapture"] });
    expect(forbidden.outcome.ok).toBe(false);
  });

  // why: S2 through the tool: cancel_collection returns the job service's CancelResult.
  // proves: CLAIM(N2-cancellation)
  it("cancels a queued job", async () => {
    const { call, okCall, qex } = await toolWorld();
    qex.control({ hold: true });
    await okCall("collect", { requestId: "tool-4", repo: "vg", adapter: "cargo", examples: ["watch.pending"] });
    const cancelled = await okCall("cancel_collection", { job: "tool-4" });
    expect(cancelled.payload.items[0]).toMatchObject({ outcome: "cancelled", qexActions: ["cancel"] });
  });
});

describe("[IV19][S12] results and failures", () => {
  // why: view_result returns the stored view's bounded text/JSON, completeness, provenance, run and object ids and the viewer link
  // (null when no viewer runs), and a candidate list when the selector is ambiguous (three event.details views in the run).
  // proves: CLAIM(IV19) CLAIM(S12-text-completeness)
  it("reads a stored view and lists candidates when ambiguous", async () => {
    const { call, session } = await toolWorld();
    must(await importCollection(session, collectionImport("vigil-redelivered")), "import");
    const { outcome, payload } = await call("view_result", { run: "run-1", view: "watch.events" });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(payload).toMatchObject({ tool: "view_result", completeness: { status: "complete" } });
    expect(payload.details).toMatchObject({ runId: "run-1", snapshotId: "snap-run-1", storedViewId: "inv-1.o1.watch.events", viewerUrl: null, objects: ["o1"] });
    expect(payload.items.map((r: any) => r.cells)).toEqual([{ event: "e-1", tick: 3, redelivered: false }, { event: "e-1", tick: 6, redelivered: true }, { event: "e-2", tick: 5, redelivered: true }]);
    const ambiguous = await call("view_result", { run: "run-1", view: "event.details" });
    expect(ambiguous.outcome.ok).toBe(false);
    expect(ambiguous.payload.code).toBe("UNRESOLVED_TARGET");
    expect(ambiguous.payload.details.candidates.map((c: any) => c.object)).toEqual(["o2", "o3", "o4"]);
  });

  // why: IV18. Recompiling alone never refreshes an old observation: the capture carries the input fingerprint with members; after a
  // source edit view_result says stale WITH the path, and the exact recollection command.
  // proves: CLAIM(IV18) CLAIM(IV14)
  it("an old capture stays stale after a source edit and names the recollection command", async () => {
    const { call, session, root, fingerprint } = await toolWorld();
    const input = collectionImport("vigil-redelivered");
    (input.run as any).inputFingerprint = { digest: fingerprint.digest, memberCount: fingerprint.members.length, sampledConsistency: "consistent-sampled", members: fingerprint.members };
    must(await importCollection(session, input), "import");
    expect((await call("view_result", { run: "run-1", view: "watch.status" })).payload.freshness.status).toBe("fresh");
    write(root, "src/lib.rs", "// edited\n");
    const { payload } = await call("view_result", { run: "run-1", view: "watch.status" });
    expect(payload.freshness).toMatchObject({ status: "stale", reasons: ["src/lib.rs: modified"] });
    expect(payload.details.recollect).toEqual({ command: "paneweft collect --request-id <new-id> --repo vg --adapter cargo --example watch.cancelled" });
  });

  const CATEGORIES = ["compiler", "typecheck", "assertion", "view-exception", "output-schema", "reference", "limit", "registration", "renderer", "runner"] as const;

  // why: IV19 / spec: explain_failure classifies all ten categories, names the offending view/example, source span, pointer, invariant,
  // expected/actual, a stderr slice, a concrete next action and a repeatable selector - evidence, not diagnosis - and executes nothing.
  // The category list is pinned by name.
  // proves: CLAIM(IV19) CLAIM(IV17)
  it.each(CATEGORIES)("explains a %s diagnostic from its stored evidence", async (category) => {
    const { call, session, qex } = await toolWorld();
    const input = collectionImport("vigil-redelivered");
    (input.graphs[0] as any).diagnostics = [{ id: `diag-${category}`, category, message: `seeded ${category} failure`, viewId: "watch.events", exampleId: "watch.cancelled", source: { path: "src/watch.rs", line: 61, column: 9 }, pointer: "/data/rows/0", invariant: "a row target resolves", expected: "o2", actual: "o99", stderrSlice: "error: seeded", nextAction: "fix the target of the row" }];
    must(await importCollection(session, input), "import");
    const { outcome, payload } = await call("explain_failure", { diagnostic: `diag-${category}` });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(payload.items[0]).toMatchObject({ id: `diag-${category}`, category, viewId: "watch.events", exampleId: "watch.cancelled", source: { path: "src/watch.rs", line: 61, column: 9 }, pointer: "/data/rows/0", invariant: "a row target resolves", expected: "o2", actual: "o99", stderrSlice: "error: seeded", nextAction: "fix the target of the row", selector: { examples: ["watch.cancelled"] }, basis: "stored-diagnostic" });
    expect(qex.calls(), "explain never executes a repair").toEqual([]);
  });
});

describe("[IV19] budgets and cursors", () => {
  // why: IV19. Every discovery reply stays within its byte budget at the smallest and largest budgets, opens with the header, and the
  // text and JSON forms agree on the facts. A budget below 2048 is BUDGET_TOO_SMALL like every v0 tool.
  // proves: CLAIM(IV19)
  it.each([2048, 4096, 32768])("list_types fits %d bytes with a complete header", async (maxBytes) => {
    const { text } = await toolWorld();
    const outcome = await text("list_types", { repo: "vg", maxBytes });
    expect(outcome.ok).toBe(true);
    expect(Buffer.byteLength(outcome.body)).toBeLessThanOrEqual(maxBytes);
    expect(outcome.body.split("\n").slice(0, 4).map((l) => l.split(":")[0])).toEqual(["paneweft.reply/2 tool=list_types", "completeness", "freshness", "counts"]);
  });

  // why: IV19. Below the floor the budget is refused with the minimum, as in v0.
  // proves: CLAIM(IV19)
  it("a budget below 2048 is BUDGET_TOO_SMALL", async () => {
    const { call } = await toolWorld();
    const { outcome, payload } = await call("list_types", { repo: "vg", maxBytes: 1024 });
    expect(outcome.ok).toBe(false);
    expect(payload.code).toBe("BUDGET_TOO_SMALL");
    expect(payload.details.minimumBytes).toBe(2048);
  });

  // why: IV19. A listing larger than the budget continues through a content-bound cursor and the pages together contain every item once;
  // a cursor from another query is CURSOR_MISMATCH, an altered one CURSOR_INVALID.
  // proves: CLAIM(IV19)
  it("pages 80 examples through cursors and refuses a mismatched cursor", async () => {
    const world = await toolWorld();
    const big = structuredClone(catalogue);
    big.examples = Array.from({ length: 80 }, (_, i) => ({ ...catalogue.examples[0], id: `ex.${String(i).padStart(2, "0")}`, selector: { ...catalogue.examples[0].selector, name: `tests::paneweft_example_${i}` } }));
    const record = JSON.parse(readFileSync(join(world.dir, "catalogues", "vg", "cargo.json"), "utf8"));
    writeFileSync(join(world.dir, "catalogues", "vg", "cargo.json"), JSON.stringify({ ...record, catalogue: big }));
    const seen: string[] = [];
    let cursor: string | undefined;
    let first: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page = await world.call("list_examples", { repo: "vg", maxBytes: 2048, ...(cursor ? { cursor } : {}) });
      expect(page.outcome.ok, page.outcome.body.slice(0, 200)).toBe(true);
      seen.push(...page.payload.items.map((e: any) => e.id));
      cursor ??= undefined;
      first ??= page.payload.cursor ?? undefined;
      cursor = page.payload.cursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(Array.from({ length: 80 }, (_, i) => `ex.${String(i).padStart(2, "0")}`));
    const mismatch = await world.call("list_examples", { repo: "vg", maxBytes: 2048, type: "vigil::watch::WatchFile", cursor: first });
    expect(mismatch.payload.code).toBe("CURSOR_MISMATCH");
    const invalid = await world.call("list_examples", { repo: "vg", maxBytes: 2048, cursor: `${first}x` });
    expect(invalid.payload.code).toBe("CURSOR_INVALID");
  });

  // why: operation order as v0: unknown tool, then SESSION_REQUIRED, then argument validation, then the target lookup.
  // proves: CLAIM(IV19)
  it("orders failures: unknown tool, no session, bad arguments", async () => {
    const unknown = await executeV1Operation({ session: null, sessionDir: null, jobs: null }, "list_everything", {});
    expect(unknown.ok ? "" : unknown.error.code).toBe("UNKNOWN_OPERATION");
    const noSession = await executeV1Operation({ session: null, sessionDir: null, jobs: null }, "list_types", { repo: "vg" });
    expect(noSession.ok ? "" : noSession.error.code).toBe("SESSION_REQUIRED");
    const { context } = await toolWorld();
    const bad = await executeV1Operation(context, "list_types", { repo: "" });
    expect(bad.ok ? "" : bad.error.code).toBe("INVALID_ARGUMENT");
  });
});

describe("[S12] scaffolds can be used from the text reply", () => {
  // why: S12. The default (text) reply of scaffold_view/scaffold_example carried only a header: the patch, the failing output test, the
  // registration step and the collect recipe were in the JSON `details` alone, so an agent reading text could not apply the scaffold.
  // Rejects a renderer that prints `details.text` only. Expected strings are written out from the scaffold's own contract.
  // proves: CLAIM(S12-scaffold)
  it.each(["scaffold_view", "scaffold_example"] as const)("%s prints the patch, the output test, the registration step and the recipe", async (tool) => {
    const { text } = await toolWorld();
    const outcome = await text(tool, { repo: "vg", type: "vigil::watch::WatchFile", ...(tool === "scaffold_view" ? { question: "Which events survive a cancel?" } : { example: "watch.new" }), maxBytes: 32768 });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(outcome.body).toContain("src/watch.rs");
    expect(outcome.body).toContain(tool === "scaffold_view" ? "#[paneweft::views(type_id = \"vigil::watch::WatchFile\")]" : "#[paneweft::example(id = ");
    expect(outcome.body).toContain("output test");
    expect(outcome.body).toContain(tool === "scaffold_view" ? "assert_eq!(view[\"completeness\"][\"status\"], \"complete\"" : "cargo test --features paneweft paneweft_example_watch_new");
    expect(outcome.body).toContain("registration:");
    expect(outcome.body).toContain("test_adapter!()");
    expect(outcome.body).toContain("paneweft collect --request-id <id> --repo vg --adapter cargo --example <example-id>");
  });

  // why: S12. A TypeScript scaffold imported `<Symbol>Token` from `./<Symbol>.paneweft.ts`, a name and a module that exist in no catalogue and in
  // no shipped fixture. The token is the one the repository declares for the type (here `Mapping`, in the module that holds the type's views),
  // and the patch extends that module in place.
  // proves: CLAIM(S12-scaffold)
  it("a TypeScript scaffold uses the token the repository declares and invents no import", async () => {
    const { session, dir } = await open();
    const root = tmp("cmrepo");
    cpSync(join(FIXTURES, "packages/containmarks-lite"), root, { recursive: true });
    mkdirSync(join(dir, "catalogues", "cm"), { recursive: true });
    const cm = loadFixture<any>("v1/catalogues/containmarks.catalogue.json");
    writeFileSync(join(dir, "catalogues", "cm", "vitest.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo: "cm", adapter: "vitest", catalogue: cm, fingerprint: { digest: "0".repeat(64), members: [], declaredExtras: [], exclusions: [] }, collectedAt: "2026-11-11T12:00:00Z" }));
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [fakeCargoAdapter({ id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", workspaceRoot: root, entry: "." })] }));
    const context: V1Context = { session, sessionDir: dir, jobs: null };
    const outcome = await executeV1Operation(context, "scaffold_view", { format: "json", repo: "cm", type: "containmarks::ContainerMappingRecord", question: "Which backup name does this mapping keep?", maxBytes: 32768 });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    const payload = JSON.parse(outcome.body);
    const [patch] = payload.details.patches;
    expect(patch.path).toBe("src/mappings/containerMappings.paneweft.ts");
    expect(patch.text).toContain("Mapping.view({");
    expect(patch.text).not.toContain("Token");
    expect(patch.text).not.toMatch(/from "\.\/ContainerMappingRecord/);
    expect(payload.details.registration).toContain("paneweft.views.ts");
    const example = JSON.parse((await executeV1Operation(context, "scaffold_example", { format: "json", repo: "cm", type: "containmarks::ContainerMappingRecord", example: "mapping.new", maxBytes: 32768 })).body);
    expect(example.details.patches[0].text).toContain('import { Mapping } from "../src/mappings/containerMappings.paneweft.ts";');
    expect(example.details.patches[0].text).toContain("type: Mapping,");

    // a type with no view yet: the patch is a whole module that declares its own token and imports only what exists
    const bare = structuredClone(cm);
    bare.types.push({ typeId: "containmarks::Backup", source: { path: "src/models.ts", symbol: "Backup" } });
    writeFileSync(join(dir, "catalogues", "cm", "vitest.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo: "cm", adapter: "vitest", catalogue: bare, fingerprint: { digest: "0".repeat(64), members: [], declaredExtras: [], exclusions: [] }, collectedAt: "2026-11-11T12:00:00Z" }));
    const fresh = JSON.parse((await executeV1Operation(context, "scaffold_view", { format: "json", repo: "cm", type: "containmarks::Backup", question: "What is in the backup?", maxBytes: 32768 })).body);
    const module = fresh.details.patches[0];
    expect(module.path).toBe("src/Backup.paneweft.ts");
    expect(module.text).toContain('import { defineType } from "@paneweft/sdk";');
    expect(module.text).toContain('import type { Backup } from "./models.ts";');
    expect(module.text).toMatch(/export const BackupToken = defineType<Backup>\(\{/);
    expect(module.text).not.toContain('from "./Backup.paneweft.ts"');
  });
});

describe("[S14r2] the sample of the sources is taken under the submission lock, before any submit", () => {
  const settledCatalogue = async (jobs: NonNullable<V1Context["jobs"]>, id: string) => vi.waitFor(async () => { expect(must(await jobs.status(id), "status").state).toBe("succeeded"); }, { timeout: 20_000, interval: 50 });

  // why: S14 (round 2). The creator sampled the sources AFTER it created the intent, and a concurrent retry (same request id, same parameters) took the
  // job from "unsubmitted" to submitted in between. The creator's sample then postdated the execution: a source edited after the retry submitted was
  // in the sample, the run's end matched it, and the record read `consistent-sampled` and "fresh". Here the creator is held between its intent and its
  // sample while a retry submits the job; the source is edited after that. Rejects an implementation that samples in the creator, outside the
  // submission lock.
  // proves: CLAIM(S14-freshness)
  it("a retry that submits before the creator samples does not let the sample postdate the run", async () => {
    const { qex, session, dir, root, adapter, fingerprint, call } = await toolWorld();
    qex.control({ hold: true });
    const make = (crashAt?: (point: string) => void | Promise<void>) => createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue, ...(crashAt === undefined ? {} : { crashAt: crashAt as never }) });
    const retry = make();
    let retried: any;
    const creator = make(async (point) => {
      if (point !== "after-intent") return;
      retried = must(await retry.refreshCatalogue({ requestId: "cat-race", repo: "vg", adapter: "cargo" }), "the retry submits the job");
      write(root, "src/lib.rs", "// edited after the retry submitted the job\n");
    });
    must(await creator.refreshCatalogue({ requestId: "cat-race", repo: "vg", adapter: "cargo" }), "creator");
    expect(retried.created, "the retry found the creator's intent").toBe(false);
    expect(qex.calls().filter((c) => c[0] === "submit")).toHaveLength(1);
    qex.release(retried.qexId);
    await settledCatalogue(retry, "cat-race");
    const record = JSON.parse(readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8"));
    expect(record.fingerprint.digest, "the sample is of the sources the job was submitted with").toBe(fingerprint.digest);
    expect(record.fingerprint.sampledConsistency).toBe("mixed-input");
    expect((await call("list_types", { repo: "vg" })).payload.freshness.status).not.toBe("fresh");
  });

  // why: S14 (round 2). A job found already submitted with no sample on record (a predecessor died before sampling, or the file is lost) cannot be
  // sampled after the fact: its inputs may be anything by now. It finishes as `unverified`, is never fresh (even when the sources match what was
  // later sampled), and no later caller can give it a sample.
  // proves: CLAIM(S14-freshness)
  it("a job recovered without a before-sample stays unverified and never gets a late one", async () => {
    const { qex, session, dir, adapter, call } = await toolWorld();
    qex.control({ crashAfterAck: true });
    const make = () => createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue });
    expect((await make().refreshCatalogue({ requestId: "cat-lost", repo: "vg", adapter: "cargo" })).ok).toBe(false);
    qex.control({ crashAfterAck: false });
    rmSync(join(dir, "jobs", "cat-lost", "fingerprint.before.json"), { force: true });
    const recovered = make();
    await settledCatalogue(recovered, "cat-lost");
    // a second caller with the same request, long after: still no sample
    expect(must(await make().refreshCatalogue({ requestId: "cat-lost", repo: "vg", adapter: "cargo" }), "again").created).toBe(false);
    expect(existsSync(join(dir, "jobs", "cat-lost", "fingerprint.before.json"))).toBe(false);
    const record = JSON.parse(readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8"));
    expect(record.fingerprint.sampledConsistency).toBe("unverified");
    expect((await call("list_types", { repo: "vg" })).payload.freshness.status).toBe("unverified");
  });

  // why: S14 control. The ordinary path: one caller, nothing edited. The sample is taken before the submit, recorded consistent, and the catalogue is fresh.
  // proves: CLAIM(S14-freshness)
  it("an undisturbed refresh is consistently sampled and fresh", async () => {
    const { qex, context, dir, call } = await toolWorld();
    must(await context.jobs!.refreshCatalogue({ requestId: "cat-calm", repo: "vg", adapter: "cargo" }), "refresh");
    await settledCatalogue(context.jobs!, "cat-calm");
    expect(JSON.parse(readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8")).fingerprint.sampledConsistency).toBe("consistent-sampled");
    expect((await call("list_types", { repo: "vg" })).payload.freshness.status).toBe("fresh");
    expect(qex.calls().filter((c) => c[0] === "submit")).toHaveLength(1);
  });
});

describe("[S12r2] a scaffold's files compile together", () => {
  /** A copy of the containmarks-lite fixture package that type-checks on its own: absolute paths to this repository's SDK and node_modules. */
  async function scaffoldWorld() {
    const { session, dir } = await open();
    const root = tmp("cmcompile");
    cpSync(join(FIXTURES, "packages/containmarks-lite"), root, { recursive: true });
    rmSync(join(root, "node_modules"), { recursive: true, force: true }); // a checkout may carry its own; the copy resolves this repository's
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2023", lib: ["ES2023", "DOM"], module: "NodeNext", moduleResolution: "NodeNext", types: ["node"], typeRoots: [join(REPO_ROOT, "node_modules/@types")], strict: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, isolatedModules: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, baseUrl: ".", paths: { "@paneweft/sdk": [join(REPO_ROOT, "packages/paneweft-ts/src/index.ts")], "@paneweft/sdk/vitest": [join(REPO_ROOT, "packages/paneweft-ts/src/vitest.ts")] } },
      include: ["src", "tests", "paneweft.views.ts"],
    }));
    appendFileSync(join(root, "src/models.ts"), "export interface Backup {\n  name: string;\n}\n");
    const cm = loadFixture<any>("v1/catalogues/containmarks.catalogue.json");
    const withBackup = structuredClone(cm);
    withBackup.types.push({ typeId: "containmarks::Backup", source: { path: "src/models.ts", symbol: "Backup" } });
    mkdirSync(join(dir, "catalogues", "cm"), { recursive: true });
    writeFileSync(join(dir, "catalogues", "cm", "vitest.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo: "cm", adapter: "vitest", catalogue: withBackup, fingerprint: { digest: "0".repeat(64), members: [], declaredExtras: [], exclusions: [] }, collectedAt: "2026-11-11T12:00:00Z" }));
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [fakeCargoAdapter({ id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", workspaceRoot: root, entry: "." })] }));
    const context: V1Context = { session, sessionDir: dir, jobs: null };
    const scaffold = async (tool: string, args: Record<string, unknown>) => {
      const outcome = await executeV1Operation(context, tool, { format: "json", repo: "cm", maxBytes: 32768, ...args });
      expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
      return JSON.parse(outcome.body).details as { patches: Array<{ path: string; text: string }>; outputTest: { path: string; text: string }; registration: string };
    };
    /** Writes what the reply hands out (patches, then the output test) into the package: a patch to an existing file is appended to it. */
    const apply = (reply: { patches: Array<{ path: string; text: string }>; outputTest: { path: string; text: string } }): void => {
      for (const file of [...reply.patches, reply.outputTest]) {
        mkdirSync(join(root, file.path, ".."), { recursive: true });
        if (existsSync(join(root, file.path))) appendFileSync(join(root, file.path), `\n${file.text}`);
        else writeFileSync(join(root, file.path), file.text);
      }
    };
    const typecheck = (): string => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], { encoding: "utf8" });
      return `${result.stdout}${result.stderr}`.trim();
    };
    return { scaffold, apply, typecheck, root };
  }

  // why: S12 (round 2). scaffold_example replaced the plan's patches with the example file alone, so for a type whose module declares no token the
  // example imported `BackupToken` from a module the reply never supplied. The files the reply returns must type-check TOGETHER, in a copy of
  // a fixture package: a token declared in the repository, and a token the reply must supply itself. Rejects a scaffold that returns an
  // import of a module nobody wrote.
  // proves: CLAIM(S12-scaffold)
  it.each([
    ["scaffold_view", "containmarks::ContainerMappingRecord", "a token the repository declares"],
    ["scaffold_example", "containmarks::ContainerMappingRecord", "a token the repository declares"],
    ["scaffold_view", "containmarks::Backup", "a token the scaffold must declare"],
    ["scaffold_example", "containmarks::Backup", "a token the scaffold must declare"],
  ] as const)("%s for %s (%s) type-checks in a copy of the package", async (tool, type, _why) => {
    const world = await scaffoldWorld();
    expect(world.typecheck(), "the fixture package type-checks before the scaffold").toBe("");
    const reply = await world.scaffold(tool, { type, ...(tool === "scaffold_view" ? { question: "What does it hold?" } : { example: "thing.new" }) });
    world.apply(reply);
    expect(world.typecheck(), `the files of ${tool} do not compile together`).toBe("");
  }, 60_000);

  // why: S12 (round 2). The example scaffold keeps the token declaration patch when no module declares a token, and its registration step
  // is for the EXAMPLE (the file that defines it and the manifest entry that carries it), not for the view the scaffold used to share a plan with.
  // proves: CLAIM(S12-scaffold)
  it("returns the token module with the example and registers the example", async () => {
    const world = await scaffoldWorld();
    const reply = await world.scaffold("scaffold_example", { type: "containmarks::Backup", example: "thing.new" });
    expect(reply.patches.map((patch) => patch.path)).toEqual(["src/Backup.paneweft.ts", "tests/thing_new.examples.ts"]);
    expect(reply.patches[0]!.text).toMatch(/export const BackupToken = defineType<Backup>\(\{/);
    expect(reply.patches[0]!.text).not.toContain(".view(");
    expect(reply.registration).toContain('path: "tests/thing_new.examples.ts"');
    expect(reply.registration).toContain("examples: [thing_new]");
    expect(reply.registration).toContain('path: "src/Backup.paneweft.ts"');
    expect(reply.registration).toContain("types: [BackupToken]");
    expect(reply.outputTest.path).toBe("tests/thing_new.paneweft.test.ts");
    expect(reply.outputTest.text).toContain("exampleTest(thing_new);");
    const declared = await world.scaffold("scaffold_example", { type: "containmarks::ContainerMappingRecord", example: "mapping.fresh" });
    expect(declared.patches.map((patch) => patch.path)).toEqual(["tests/mapping_fresh.examples.ts"]);
    expect(declared.registration).toContain("examples: [mapping_fresh]");
    expect(declared.registration).not.toContain("types:");
  }, 60_000);

  // why: S12 (round 2). The Rust example scaffold's registration step was the view recipe (`#[paneweft::views]`); an example registers through
  // `#[paneweft::example]`.
  // proves: CLAIM(S12-scaffold)
  it("a Rust example scaffold registers through the example attribute", async () => {
    const { text, call } = await toolWorld();
    void text;
    const { payload } = await call("scaffold_example", { repo: "vg", type: "vigil::watch::WatchFile", example: "watch.new", maxBytes: 32768 });
    expect(payload.details.registration).toContain("#[paneweft::example]");
    expect(payload.details.registration).not.toContain("#[paneweft::views]");
  });
});

describe("[D4] the Rust scaffold compiles", () => {
  /** A copy of the Boat fixture crate, catalogued as `boat::Boat`, whose path dependency points at this repository's SDK. */
  async function boatWorld() {
    const { session, dir } = await open();
    const root = tmp("boat");
    cpSync(join(FIXTURES, "crates/boat"), root, { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), readFileSync(join(root, "Cargo.toml"), "utf8").replace("../../../crates/paneweft", join(REPO_ROOT, "crates/paneweft")));
    cpSync(join(REPO_ROOT, "Cargo.lock"), join(root, "Cargo.lock")); // the versions the SDK itself builds with, so the check needs no network
    const withBoat = structuredClone(catalogue);
    withBoat.types.push({ typeId: "boat::Boat", source: { path: "src/lib.rs", symbol: "Boat" } });
    mkdirSync(join(dir, "catalogues", "vg"), { recursive: true });
    writeFileSync(join(dir, "catalogues", "vg", "cargo.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo: "vg", adapter: "cargo", catalogue: withBoat, fingerprint: { digest: "0".repeat(64), members: [], declaredExtras: [], exclusions: [] }, collectedAt: "2026-11-11T12:00:00Z" }));
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [fakeCargoAdapter({ workspaceRoot: root })] }));
    const context: V1Context = { session, sessionDir: dir, jobs: null };
    const scaffold = async (tool: string, args: Record<string, unknown>) => {
      const outcome = await executeV1Operation(context, tool, { format: "json", repo: "vg", maxBytes: 32768, ...args });
      expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
      return JSON.parse(outcome.body).details as { patches: Array<{ path: string; text: string }>; outputTest: { path: string; text: string }; registration: string };
    };
    const check = (): { status: number | null; output: string } => {
      const result = spawnSync("cargo", ["check", "--tests", "--features", "paneweft", "--offline", "--message-format", "short"], { cwd: root, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(REPO_ROOT, "target", "scaffold-check") } });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    return { scaffold, check, root };
  }

  // why: D4 / S12 (round 3). The Rust example scaffold put `fn boat_new() -> Boat` inside a nested `mod examples`, which does not see the type of
  // the module around it: the generated example did not compile, and nothing compiled it. The patch must import the type it returns from
  // `super`. Rejects a scaffold whose nested module names a type it does not import.
  // proves: CLAIM(S12-scaffold)
  it("imports the selected type into the module that holds the example", async () => {
    const { call } = await toolWorld();
    const { payload } = await call("scaffold_example", { repo: "vg", type: "vigil::watch::WatchFile", example: "watch.new", maxBytes: 32768 });
    const patch = payload.details.patches[0].text as string;
    expect(patch).toMatch(/mod paneweft_examples \{\s+(\/\/[^\n]*\n\s+)?use super::WatchFile;/);
  });

  // why: D4 / S12 (round 3). The scaffold is code a person pastes: one generated Rust example is compiled, with the SDK and its feature, in a copy
  // of a small crate whose type (`Boat`) already carries a views impl. The control proves the copy builds before the patch is applied.
  // Rejects any generated Rust that is never compiled.
  // proves: CLAIM(S12-scaffold)
  it("compiles the generated example for Boat next to the type", async () => {
    const world = await boatWorld();
    const before = world.check();
    expect(before.status, `the fixture crate builds before the scaffold: ${before.output.slice(-600)}`).toBe(0);
    const reply = await world.scaffold("scaffold_example", { type: "boat::Boat", example: "boat.new" });
    expect(reply.patches.map((patch) => patch.path)).toEqual(["src/lib.rs"]);
    appendFileSync(join(world.root, "src/lib.rs"), `\n${reply.patches[0]!.text}`);
    const after = world.check();
    expect(after.status, `the generated example does not compile:\n${after.output.slice(-900)}`).toBe(0);
  }, 300_000);
});

describe("[S13] a diagnostic id names its run", () => {
  const settled = async (call: (tool: string, args?: Record<string, unknown>) => Promise<{ payload: any }>, job: string) => vi.waitFor(async () => { const s = await call("collection_status", { job }); expect(["failed", "succeeded"]).toContain(s.payload.items[0].state); return s.payload.items[0]; }, { timeout: 20_000, interval: 50 });

  // why: S13. Compile, catalogue, registration and synthesized invocation diagnostics are numbered per collection (`diag-inv-1`, `diag-compile-1`),
  // and explain_failure returned the first match across every job, so the second of two consecutive, different failures explained the first.
  // Rejects a lookup that scans jobs for the bare id. Ids reported by collection_status are qualified by their run and unambiguous.
  // proves: CLAIM(S13-diagnostic-ids)
  it("explains the failure of the run it names, for consecutive distinct failures", async () => {
    const { call, okCall, qex } = await toolWorld();
    qex.scenario({ mode: "fail" });
    const ids: Record<string, string[]> = {};
    for (const job of ["fail-a", "fail-b"]) {
      await okCall("collect", { requestId: job, repo: "vg", adapter: "cargo", examples: ["watch.pending"] });
      ids[job] = (await settled(call, job)).diagnosticIds;
      expect(ids[job]!.length).toBeGreaterThan(0);
    }
    expect(ids["fail-a"]!.filter((id) => ids["fail-b"]!.includes(id)), "no id is shared between the two runs").toEqual([]);
    for (const job of ["fail-a", "fail-b"]) {
      for (const id of ids[job]!) {
        const explained = await okCall("explain_failure", { diagnostic: id });
        expect(explained.payload.items[0]).toMatchObject({ runId: `run-${job}`, qualifiedId: id });
      }
    }
  });

  // why: S13. The bare id that two runs share is no longer answered with whichever run came first: it is UNRESOLVED_TARGET naming the qualified ids.
  // proves: CLAIM(S13-diagnostic-ids)
  it("refuses a bare id that more than one run holds and lists the qualified ones", async () => {
    const { call, okCall, qex } = await toolWorld();
    qex.scenario({ mode: "fail" });
    for (const job of ["fail-c", "fail-d"]) {
      await okCall("collect", { requestId: job, repo: "vg", adapter: "cargo", examples: ["watch.pending"] });
      await settled(call, job);
    }
    const { outcome, payload } = await call("explain_failure", { diagnostic: "diag-inv-1" });
    expect(outcome.ok).toBe(false);
    expect(payload.code).toBe("UNRESOLVED_TARGET");
    expect(payload.details.candidates).toEqual(["run-fail-c:diag-inv-1", "run-fail-d:diag-inv-1"]);
  });
});

describe("[S14] freshness never blesses what changed while it was being compiled", () => {
  // why: S14. A catalogue's fingerprint was taken AFTER the export ran, so a source edited between the start of the job and its end was blessed:
  // the record matched the edited files and list_types said "fresh". The record now holds the fingerprint of the sources the job started from, with the
  // consistency of the two samples; a mixed sample is never fresh.
  // proves: CLAIM(S14-freshness)
  it("a catalogue refreshed while its sources were edited is not fresh", async () => {
    const { call, root, qex, context, dir, fingerprint } = await toolWorld();
    qex.control({ hold: true });
    const started = must(await context.jobs!.refreshCatalogue({ requestId: "cat-edit", repo: "vg", adapter: "cargo" }), "refresh");
    const before = independentFingerprint(root).digest;
    expect(before).toBe(fingerprint.digest);
    write(root, "src/lib.rs", "// edited while the catalogue was being compiled\n");
    qex.release(started.qexId!);
    await vi.waitFor(async () => { expect(must(await context.jobs!.status("cat-edit"), "status").state).toBe("succeeded"); }, { timeout: 20_000, interval: 50 });
    const record = JSON.parse(readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8"));
    expect(record.fingerprint.digest, "the record holds the sources the job started from").toBe(before);
    expect(record.fingerprint.sampledConsistency).toBe("mixed-input");
    const { payload } = await call("list_types", { repo: "vg" });
    expect(payload.freshness.status).not.toBe("fresh");
  });

  // why: S14. view_result recomputed the current fingerprint and compared it with the run's recorded digest, ignoring that the run recorded
  // `mixed-input`: an edit made during the run and then restored compared equal, so the result read "fresh". A recorded mixed (or unverified) sample caps freshness at unverified.
  // proves: CLAIM(S14-freshness)
  it.each(["mixed-input", "unverified"] as const)("a run recorded as %s is never reported fresh, even when the sources match", async (consistency) => {
    const { call, session, fingerprint } = await toolWorld();
    const input = collectionImport("vigil-redelivered");
    (input.run as any).inputFingerprint = { digest: fingerprint.digest, memberCount: fingerprint.members.length, sampledConsistency: consistency, members: fingerprint.members };
    must(await importCollection(session, input), "import");
    const { payload } = await call("view_result", { run: "run-1", view: "watch.status" });
    expect(payload.freshness.status).toBe("unverified");
    expect(payload.freshness.reasons.join(" ")).toContain(consistency === "mixed-input" ? "mixed" : "unverified");
  });

  // why: S14 control. The same run recorded as consistently sampled and matching the sources is fresh: the cap applies only to a recorded doubt.
  // proves: CLAIM(S14-freshness)
  it("a consistently sampled run that matches the sources is fresh", async () => {
    const { call, session, fingerprint } = await toolWorld();
    const input = collectionImport("vigil-redelivered");
    (input.run as any).inputFingerprint = { digest: fingerprint.digest, memberCount: fingerprint.members.length, sampledConsistency: "consistent-sampled", members: fingerprint.members };
    must(await importCollection(session, input), "import");
    expect((await call("view_result", { run: "run-1", view: "watch.status" })).payload.freshness.status).toBe("fresh");
  });
});

describe("[S15] the inventory is checked at refresh and the coverage is real", () => {
  const inventory = loadFixture<any>("v1/catalogues/watchfile.inventory.json");

  // why: S15. `checkInventory` was never called: a module whose import was removed (here: the inventory still declares a view of module `ghost`
  // that the compiled catalogue no longer carries) refreshed successfully and replaced the stored catalogue. A refresh that fails the inventory
  // fails as a registration diagnostic and leaves the stored catalogue as it was.
  // proves: CLAIM(S15-inventory) CLAIM(IV3)
  it("fails a refresh that drops a declared module and keeps the stored catalogue", async () => {
    const { root, qex, context, dir, call } = await toolWorld();
    const stored = readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8");
    write(root, "paneweft.inventory.json", JSON.stringify({ ...inventory, views: [...inventory.views, { id: "ghost.view", module: "ghost" }] }));
    must(await context.jobs!.refreshCatalogue({ requestId: "cat-ghost", repo: "vg", adapter: "cargo" }), "refresh");
    const view = await vi.waitFor(async () => { const s = must(await context.jobs!.status("cat-ghost"), "status"); expect(s.state).toBe("failed"); return s; }, { timeout: 20_000, interval: 50 });
    expect(view.diagnosticIds.length).toBeGreaterThan(0);
    const explained = await call("explain_failure", { diagnostic: view.diagnosticIds[0]! });
    expect(explained.payload.items[0]).toMatchObject({ category: "registration" });
    expect(JSON.stringify(explained.payload.items[0])).toContain("ghost");
    expect(readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8")).toBe(stored);
    expect(qex.calls().some((c) => c[0] === "submit")).toBe(true);
  });

  // why: S15. list_types reported `declared` and `linked` as the same catalogue count and had no exercised/passing figures. With the checked-in inventory and
  // the imported runs they are separate numbers: declared 3 (the inventory), linked 3 (the catalogue), exercised 2 and passing 2 (the imported run).
  // proves: CLAIM(S15-inventory)
  it("reports declared, linked, exercised and passing separately", async () => {
    const { root, qex, context, call, session } = await toolWorld();
    write(root, "paneweft.inventory.json", JSON.stringify(inventory));
    must(await context.jobs!.refreshCatalogue({ requestId: "cat-ok", repo: "vg", adapter: "cargo" }), "refresh");
    await vi.waitFor(async () => { expect(must(await context.jobs!.status("cat-ok"), "status").state).toBe("succeeded"); }, { timeout: 20_000, interval: 50 });
    must(await importCollection(session, collectionImport("vigil-redelivered")), "import");
    const { payload } = await call("list_types", { repo: "vg" });
    expect(payload.details.coverage).toMatchObject({ declared: 3, linked: 3, exercised: 2, passing: 2 });
    expect(payload.details.coverage.gaps).toEqual([{ viewId: "event.details", reason: "no-example" }]);
    expect(qex.calls().length).toBeGreaterThan(0);
  });

  // why: S15. The Vitest exporter compiled the manifest with NO independent list of declared modules, so a module whose import was removed from
  // paneweft.views.ts was invisible. It now reads the repository's checked-in inventory and refuses a manifest that lacks a declared module
  // (the compiler's missing-import problem). Run on the real script and the shipped containmarks fixture.
  // proves: CLAIM(S15-inventory) CLAIM(IV3)
  it("the Vitest catalogue export fails when a declared module is no longer imported", () => {
    const root = join(FIXTURES, "packages/containmarks-lite");
    const run = (declared: string[]) => {
      const staging = tmp("vitest-catalogue");
      const file = join(staging, "inventory.json");
      writeFileSync(file, JSON.stringify({ schemaVersion: "paneweft.inventory/1", views: declared.map((module, index) => ({ id: `declared.view-${index}`, module })), examples: [] }));
      const result = spawnSync(process.execPath, [join(FIXTURES, "../scripts/collect-vitest.mjs"), "--staging", staging, "--root", root, "--tsconfig", "tsconfig.json", "--catalogue", "--manifest", "paneweft.views.ts", "--inventory", file], { encoding: "utf8", timeout: 120_000 });
      return { status: result.status, stderr: result.stderr };
    };
    const ok = run(["src/mappings/containerMappings.paneweft.ts"]);
    expect(ok.status, ok.stderr).toBe(0);
    const removed = run(["src/mappings/containerMappings.paneweft.ts", "src/mappings/removed.paneweft.ts"]);
    expect(removed.status).toBe(3);
    expect(removed.stderr).toContain("missing-import");
    expect(removed.stderr).toContain("src/mappings/removed.paneweft.ts");
  });
});

describe("[S16] discovery covers every registered catalogue", () => {
  async function twoCatalogues() {
    const world = await toolWorld();
    const cm = loadFixture<any>("v1/catalogues/containmarks.catalogue.json");
    const record = { schemaVersion: "paneweft.catalogue-record/1", repo: "vg", adapter: "vitest", catalogue: cm, fingerprint: { digest: "0".repeat(64), members: [], declaredExtras: [], exclusions: [] }, collectedAt: "2026-11-11T12:00:00Z" };
    writeFileSync(join(world.dir, "catalogues", "vg", "vitest.json"), JSON.stringify(record));
    return world;
  }

  // why: S16. list_types and list_examples read `records[0]` only, so with a Rust and a TypeScript adapter registered for one repository the other adapter's
  // declarations vanished. Both catalogues are listed, each item says which scope it came from, and the reply names every scope.
  // proves: CLAIM(S16-discovery)
  it("lists the types and the examples of every adapter's catalogue", async () => {
    const { okCall } = await twoCatalogues();
    const types = await okCall("list_types", { repo: "vg" });
    expect(types.payload.items.map((item: any) => item.typeId)).toEqual(["containmarks::ContainerMappingRecord", "vigil::watch::Event", "vigil::watch::WatchFile"]);
    expect(types.payload.details.scopes.map((scope: any) => scope.adapter)).toEqual(["cargo", "vitest"]);
    const examples = await okCall("list_examples", { repo: "vg" });
    expect(examples.payload.items.map((item: any) => item.id)).toEqual(expect.arrayContaining(["mapping.work", "mapping.renamed", "watch.cancelled", "watch.pending"]));
    expect(examples.payload.counts.total).toBe(examples.payload.items.length);
    const typescript = await okCall("list_types", { repo: "vg", language: "typescript" });
    expect(typescript.payload.items.map((item: any) => item.typeId)).toEqual(["containmarks::ContainerMappingRecord"]);
  });

  // why: S16. list_views_for_type ignored its `target` argument. A target selects the scope whose package, target or adapter id it names, and an unknown one
  // is refused with the scopes that exist; without one, the views of the type come from every scope that declares it.
  // proves: CLAIM(S16-discovery)
  it("honours the target argument and reports the scope it used", async () => {
    const { okCall, call } = await twoCatalogues();
    const selected = await okCall("list_views_for_type", { repo: "vg", type: "containmarks::ContainerMappingRecord", target: "containmarks-lite" });
    expect(selected.payload.items.map((item: any) => item.id)).toEqual(["mapping.details"]);
    expect(selected.payload.details.scopes.map((scope: any) => scope.adapter)).toEqual(["vitest"]);
    const wrong = await call("list_views_for_type", { repo: "vg", type: "containmarks::ContainerMappingRecord", target: "watchfile" });
    expect(wrong.outcome.ok).toBe(true);
    expect(wrong.payload.items).toEqual([]);
    expect(wrong.payload.completeness.status).toBe("partial");
    const unknown = await call("list_views_for_type", { repo: "vg", type: "containmarks::ContainerMappingRecord", target: "nowhere" });
    expect(unknown.outcome.ok).toBe(false);
    expect(unknown.payload.code).toBe("NOT_FOUND");
    expect(unknown.payload.message).toContain("containmarks-lite");
    const all = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    expect(all.payload.items.map((item: any) => item.id).sort()).toEqual(["watch.events", "watch.status"]);
  });
});

describe("[T4] discovery and scaffolding on a repository whose catalogue is not stored yet", () => {
  const bare = async () => {
    const world = await toolWorld();
    rmSync(join(world.dir, "catalogues"), { recursive: true, force: true });
    return world;
  };

  // WHY CLAIM(T4-fresh-repo): list_types answered NOT_FOUND "ask the owner to run catalogue refresh" for a repository whose adapter is registered but whose
  // catalogue is not stored yet, which stalled an agent at the first step of the skill. A missing catalogue is an ok, partial, unverified answer that says
  // the first collect exports it (contract section 11: never a statement that nothing exists).
  it("list_types, list_views_for_type and list_examples answer partial and unverified, naming the first collect", async () => {
    const { okCall } = await bare();
    const types = await okCall("list_types", { repo: "vg" });
    expect(types.payload).toMatchObject({ completeness: { status: "partial" }, freshness: { status: "unverified" }, counts: { unit: "types", total: 0, returned: 0 } });
    expect(types.payload.notices.join(" ")).toMatch(/first collect/);
    expect(types.payload.notices.join(" ")).not.toMatch(/catalogue refresh/);
    const views = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    expect(views.payload).toMatchObject({ completeness: { status: "partial" }, freshness: { status: "unverified" }, counts: { unit: "views", total: 0 } });
    expect(views.payload.notices.join(" ")).toMatch(/first collect/);
    const examples = await okCall("list_examples", { repo: "vg" });
    expect(examples.payload).toMatchObject({ completeness: { status: "partial" }, counts: { unit: "examples", total: 0 } });
  });

  // WHY CLAIM(T4-fresh-repo): scaffold_view needed a catalogue record to find the repository's adapter, so it failed on a fresh repository even with an
  // explicit source (the spec's route for a type that is not catalogued yet). It takes the source as a candidate and the adapter from the owner's registration.
  it("scaffold_view takes an explicit source when nothing is catalogued, and asks for one when it is missing", async () => {
    const { okCall, call } = await bare();
    const missing = await call("scaffold_view", { repo: "vg", type: "vigil::watch::WatchFile", question: "Which events survive?" });
    expect(missing.outcome.ok).toBe(false);
    expect(missing.payload.code).toBe("UNRESOLVED_TARGET");
    expect(missing.payload.message).toMatch(/source/);
    expect(missing.payload.message).not.toMatch(/refresh/);
    const { payload } = await okCall("scaffold_view", { repo: "vg", type: "vigil::watch::WatchFile", question: "Which events survive?", source: { path: "src/watch.rs", symbol: "WatchFile" } });
    expect(payload.tool).toBe("scaffold_view");
    expect(payload.notices.join(" ")).toMatch(/not catalogued/);
    expect(JSON.stringify(payload.details)).not.toMatch(/then refresh the catalogue/);
  });

  // WHY CLAIM(T4-fresh-repo): with no adapter registered there is nothing that could export a catalogue; that is the owner's decision and the answer names it.
  it("without a registered adapter the answer names the owner action", async () => {
    const { dir, call } = await bare();
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [] }));
    const result = await call("list_types", { repo: "vg" });
    expect(result.outcome.ok).toBe(false);
    expect(result.payload.code).toBe("NOT_FOUND");
    expect(result.payload.message).toMatch(/paneweft adapter add/);
  });
});
