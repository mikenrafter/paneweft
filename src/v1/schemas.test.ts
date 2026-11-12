// Scaffold self-checks for the v1 contracts (green by design: they pass against the stubs and guard the red fixtures themselves),
// plus the red wiring of the generated declarations. A fixture that does not validate would make every red test below meaningless.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, collectionFixture, loadFixture } from "../../test/helpers/v1-world.ts";
import { V1_ACTING_TOOLS, V1_READ_ONLY_TOOLS, V1_REQUIRED_TOOL_NAMES, V1_TOOL_NAMES, createV1SchemaRegistry, loadV1SchemaDocuments, validateAgainstV1 } from "./schemas.ts";

const OBJECT_GRAPH = "urn:paneweft:schema:v1:object-graph:1";
const TEST_RUN = "urn:paneweft:schema:v1:test-run:1";

describe("[scaffold] v1 schemas", () => {
  // why: every v1 schema must compile under the repo's strict Ajv with the v0 documents registered; a schema typo would otherwise
  // surface as a confusing failure in a behaviour test.
  // proves: CLAIM(IV20)
  it("all v1 schema documents compile together with the v0 documents", () => {
    const ajv = createV1SchemaRegistry();
    const ids = loadV1SchemaDocuments().map((d) => d.id);
    expect(ids.length).toBeGreaterThanOrEqual(21);
    for (const id of ids) expect(ajv.getSchema(id), id).toBeDefined();
  });

  // why: the tool list is pinned by name: emptying it or renaming a tool must break a test (test-quality: iterating over the current set).
  // proves: CLAIM(S1-week-one-cut)
  it("the ten v1 tools have a schema file each and the read/acting split covers them exactly", () => {
    expect([...V1_TOOL_NAMES]).toEqual(["list_types", "list_views_for_type", "list_examples", "scaffold_view", "scaffold_example", "collect", "collection_status", "cancel_collection", "view_result", "explain_failure"]);
    const files = readdirSync(join(REPO_ROOT, "src/schemas/v1/tools")).map((f) => f.replace(".schema.json", "")).sort();
    expect(files).toEqual([...V1_TOOL_NAMES].sort());
    expect([...V1_READ_ONLY_TOOLS, ...V1_ACTING_TOOLS].sort()).toEqual([...V1_TOOL_NAMES].sort());
    expect(V1_REQUIRED_TOOL_NAMES).not.toContain("scaffold_example");
    expect(V1_REQUIRED_TOOL_NAMES).toHaveLength(9);
  });

  // why: the collection fixtures are the literal inputs of the import, read and text tests; they must satisfy the schemas that the
  // validator will enforce, or the red tests would fail for the wrong reason.
  // proves: CLAIM(IV9) CLAIM(IV20)
  it("the collection fixtures validate against their schemas", () => {
    for (const name of ["vigil-redelivered", "containmarks-mapping", "cycle-alias"]) {
      const { run, graphs } = collectionFixture(name);
      expect(validateAgainstV1(TEST_RUN, run), `${name} test-run`).toEqual([]);
      for (const graph of graphs) expect(validateAgainstV1(OBJECT_GRAPH, graph), `${name} object-graph`).toEqual([]);
    }
  });

  // why: the graph scenarios' expected objects (minus the reviewer-only hashInput) are the object records the SDKs must emit, so they
  // must be schema-valid and their content hashes must match the stated hash input (printf %s "$hashInput" | sha256sum).
  // proves: CLAIM(IV9)
  it("the graph scenario fixtures are schema-valid and their hashes match their stated inputs", async () => {
    const { createHash } = await import("node:crypto");
    for (const name of ["shared-child", "cycle", "self-cycle", "duplicate-domain-keys", "depth-limit", "object-limit", "reference-limit", "separate-observations", "identity-token"]) {
      const scenario = loadFixture<any>(`v1/graphs/${name}.json`);
      for (const { hashInput, ...record } of scenario.expected.objects) {
        expect(createHash("sha256").update(hashInput).digest("hex"), `${name}/${record.id}`).toBe(record.contentHash);
        const graph = { schemaVersion: "paneweft.object-graph/1", captureId: "c", runId: "r", invocationId: "i", roots: [], objects: [record], views: [], pages: [], diagnostics: [], limits: { depth: 4, objects: 1000, references: 4000, rootBytes: 2097152, stringBytes: 16384, pageRows: 100, collectionBytes: 33554432, roots: 100, viewRows: 10000, viewBudgetMs: 100 }, completeness: { status: "complete" } };
        expect(validateAgainstV1(OBJECT_GRAPH, graph), `${name}/${record.id}`).toEqual([]);
      }
    }
  });

  // why: the shared tagged-value fixture must itself be valid Value JSON, or a green encoder could pass by matching an invalid literal.
  // proves: CLAIM(S11-tagged-values)
  it("every expected tagged value validates as a Value", () => {
    const fixture = loadFixture<any>("v1/values.json");
    for (const item of fixture.cases) {
      const graph = { schemaVersion: "paneweft.object-graph/1", captureId: "c", runId: "r", invocationId: "i", roots: ["o1"], objects: [{ id: "o1", typeId: "t", domainKey: null, label: "", fields: { v: item.expected }, edges: [], views: [], contentHash: "0".repeat(64) }], views: [], pages: [], diagnostics: [], limits: { depth: 4, objects: 1000, references: 4000, rootBytes: 2097152, stringBytes: 16384, pageRows: 100, collectionBytes: 33554432, roots: 100, viewRows: 10000, viewBudgetMs: 100 }, completeness: { status: "complete" } };
      expect(validateAgainstV1(OBJECT_GRAPH, graph), item.name).toEqual([]);
    }
  });

  // why: a plain object that carries the reserved key but is not a known tag must be REJECTED by the schema (the tag space is closed).
  // proves: CLAIM(S11-tagged-values)
  it("an unknown tag is refused (negative control for the Value schema)", () => {
    const graph = { schemaVersion: "paneweft.object-graph/1", captureId: "c", runId: "r", invocationId: "i", roots: ["o1"], objects: [{ id: "o1", typeId: "t", domainKey: null, label: "", fields: { v: { $paneweft: "bogus" } }, edges: [], views: [], contentHash: "0".repeat(64) }], views: [], pages: [], diagnostics: [], limits: { depth: 4, objects: 1000, references: 4000, rootBytes: 2097152, stringBytes: 16384, pageRows: 100, collectionBytes: 33554432, roots: 100, viewRows: 10000, viewBudgetMs: 100 }, completeness: { status: "complete" } };
    expect(validateAgainstV1(OBJECT_GRAPH, graph).length).toBeGreaterThan(0);
  });

  // why: the outcome scenario fixtures are the literal inputs of the reconcilers; their `expected.counts.selected` must equal the number
  // of selected examples or the fixture contradicts itself.
  // proves: CLAIM(S6-outcomes)
  it("the outcome fixtures are internally consistent and cover the same scenario names for both adapters", () => {
    const cargo = loadFixture<any>("v1/outcomes/cargo.scenarios.json").scenarios;
    const vitest = loadFixture<any>("v1/outcomes/vitest.scenarios.json").scenarios;
    const shared = cargo.map((s: any) => s.scenario).filter((n: string) => n !== "binary-failure-after-tests");
    expect(shared).toEqual(vitest.map((s: any) => s.scenario).filter((n: string) => n !== "teardown-failure-after-tests"));
    expect(shared).toEqual(["all-pass", "assertion-failure", "panic-or-err-is-error", "zero-check-is-exploratory", "retry-keeps-the-prior-failure", "child-failure-blocks-parent", "expected-failure-passes", "capture-failed-native-passed", "skipped-and-filtered-are-distinct", "worker-crash-has-no-completion-record", "compile-failure", "timeout", "cancelled"]);
    for (const s of [...cargo, ...vitest]) expect(s.expected.counts.selected, s.scenario).toBe(s.input.selected.length);
  });

  // why: the generated declarations are derivatives of the schemas; a stale file would let consumer code compile against old shapes.
  // proves: CLAIM(S10-generated-types)
  it("the generated v1 declarations are current", () => {
    const run = spawnSync(process.execPath, ["scripts/gen-types-v1.mjs", "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(REPO_ROOT, "src/generated/v1/ObjectGraph.ts"), "utf8")).toContain("export interface ObjectGraph");
  });
});
