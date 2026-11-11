// The agent tools through the shared handler (IV14, IV15, IV19, S12): discovery that never executes code and never asserts absence,
// read-only scaffolding, collection through the job service, result and failure reads, byte budgets and cursors. CLI/MCP parity is in
// test/v1/surface.test.ts.
import { createHash } from "node:crypto";
import { cpSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FIXTURES, collectionImport, fakeCargoAdapter, git, loadFixture, makeRepo, useFakeQex, useV1Sessions, write } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { importCollection } from "./import.ts";
import { createJobService } from "./jobs.ts";
import { V1_TOOL_NAMES } from "./schemas.ts";
import { executeV1Operation, v1ToolDescriptors, type V1Context } from "./tools.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const catalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");

/** An independent fingerprint of a repo directory (git ls-files + untracked), so the seed does not depend on the code under test. */
function independentFingerprint(root: string) {
  const files = (args: string[]) => git(root, ...args).split("\n").filter(Boolean);
  const paths = [...new Set([...files(["ls-files"]), ...files(["ls-files", "--others", "--exclude-standard"])])].sort();
  const members = paths.map((p) => ({ path: p, sha256: createHash("sha256").update(readFileSync(join(root, p))).digest("hex") }));
  const digest = createHash("sha256").update(members.map((m) => `${m.path}\0${m.sha256}\n`).join("")).digest("hex");
  return { digest, members, declaredExtras: [], exclusions: [] };
}

async function toolWorld(options: { registerRoot?: boolean; stale?: boolean } = {}) {
  const { session, dir } = await open();
  const root = tmp("vigilrepo");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  makeRepo(root, {});
  const fingerprint = independentFingerprint(root);
  mkdirSync(join(dir, "catalogues", "vg"), { recursive: true });
  writeFileSync(join(dir, "catalogues", "vg", "cargo.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo: "vg", adapter: "cargo", catalogue, fingerprint, collectedAt: "2026-11-11T12:00:00Z" }));
  const adapter = fakeCargoAdapter({ workspaceRoot: root });
  writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [adapter] }));
  if (options.registerRoot !== false) must(await session.registerRepository({ id: "vg", root }), "register root");
  if (options.stale) write(root, "src/lib.rs", "// edited after the catalogue was compiled\n");
  const qex = fake();
  const jobs = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue });
  const context: V1Context = { session, sessionDir: dir, jobs };
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const outcome = await executeV1Operation(context, tool, { format: "json", ...args });
    return { outcome, payload: outcome.ok ? JSON.parse(outcome.body) : JSON.parse(outcome.body) };
  };
  const text = async (tool: string, args: Record<string, unknown> = {}) => executeV1Operation(context, tool, { format: "text", ...args });
  /** A call that must succeed: the assertion happens here, so a failing stub is an assertion failure and not a TypeError further down. */
  const okCall = async (tool: string, args: Record<string, unknown> = {}) => { const result = await call(tool, args); expect(result.outcome.ok, `${tool}: ${result.outcome.body.slice(0, 300)}`).toBe(true); return result; };
  return { session, dir, root, qex, call, okCall, text, context, fingerprint };
}

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
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page = await okCall("scaffold_view", { repo: "vg", type: "vigil::watch::WatchFile", question: "Q?", maxBytes: 2048, ...(cursor ? { cursor } : {}) });
      expect(page.outcome.ok, page.outcome.body.slice(0, 200)).toBe(true);
      expect(Buffer.byteLength(page.outcome.body)).toBeLessThanOrEqual(2048);
      for (const patch of page.payload.details.patches) { expect(patch.part).toBeDefined(); expect(patch.ofParts).toBeGreaterThan(1); parts.push(patch.text); }
      cursor = page.payload.cursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(parts.join("")).toBe(fullText);
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
    expect(outcome.body).toContain("assert!(false");
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
