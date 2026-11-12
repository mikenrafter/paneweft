// Catalogue merge, inventory check and the four coverage numbers (IV3, IV14, IV18).
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { checkInventory, coverage, mergeCatalogue, type CataloguePart } from "./catalogue.ts";

const watch = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");
const inventory = loadFixture<any>("v1/catalogues/watchfile.inventory.json");
const part = (source: string, views: any[], examples: any[], types = watch.types): CataloguePart => ({ source, types, views, examples });

describe("[IV3] merge", () => {
  // why: IV3. Parts from separately linked binaries merge into one catalogue sorted by id; the digest is the one stated in the reviewed
  // fixture (sha256 of the canonical types/views/examples/target) and does not depend on part order.
  // proves: CLAIM(IV3)
  it("is sorted and order independent, with the fixture's digest", () => {
    const one = must(mergeCatalogue([part("lib", watch.views.slice(0, 2), watch.examples.slice(0, 1)), part("tests/it", watch.views.slice(2), watch.examples.slice(1), [])], watch.target, watch.linkedScope), "forward");
    const two = must(mergeCatalogue([part("tests/it", watch.views.slice(2), watch.examples.slice(1), []), part("lib", watch.views.slice(0, 2), watch.examples.slice(0, 1))], watch.target, watch.linkedScope), "backward");
    expect(one).toEqual(two);
    expect(one.views.map((v) => v.id)).toEqual(["event.details", "watch.events", "watch.status"]);
    expect(one.digest).toBe(watch.digest);
  });

  // why: IV3. Two parts declaring one id report BOTH sources; the catalogue is not produced (no silent last-wins).
  // proves: CLAIM(IV3)
  it("a duplicate id names both declarations", () => {
    const duplicate = { ...watch.views[2], source: { path: "src/other.rs", line: 5 } };
    const error = mustFail(mergeCatalogue([part("lib", [watch.views[2]], []), part("tests/it", [duplicate], [])], watch.target, watch.linkedScope), "duplicate");
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toMatchObject({ duplicates: [{ id: "watch.status", kind: "view", sources: [{ path: "src/watch.rs", line: 41 }, { path: "src/other.rs", line: 5 }] }] });
  });
});

describe("[IV18] inventory", () => {
  // why: IV18 positive control: the fixture catalogue and the fixture inventory agree.
  // proves: CLAIM(IV18)
  it("agree when nothing changed, and disagree when a view is gone (negative control)", () => {
    expect(checkInventory(watch, inventory)).toEqual({ ok: true, problems: [] });
    const without = structuredClone(watch);
    without.views = without.views.filter((v: any) => v.id !== "watch.status");
    expect(checkInventory(without, inventory).ok).toBe(false);
  });

  // why: IV18. A removed id, a vanished module (a forgotten manifest import), an unlisted new id, a changed return type and a duplicate
  // are each a named problem. Intentional removal updates the inventory in the same change.
  // proves: CLAIM(IV18) CLAIM(IV3)
  it.each([
    ["a removed view", (c: any) => void (c.views = c.views.filter((v: any) => v.id !== "watch.events")), { kind: "removed-view", id: "watch.events", module: "watch" }],
    ["a removed example", (c: any) => void (c.examples = c.examples.filter((e: any) => e.id !== "watch.pending")), { kind: "removed-example", id: "watch.pending", module: "watch" }],
    ["an unlisted view", (c: any) => void c.views.push({ ...c.views[0], id: "watch.new" }), { kind: "unlisted", id: "watch.new", module: "watch" }],
    ["a changed return type", (c: any) => void (c.examples[0].typeId = "vigil::watch::Event"), { kind: "return-type-changed", id: "watch.cancelled", expected: "vigil::watch::WatchFile", actual: "vigil::watch::Event" }],
  ])("reports %s", (_name, mutate, problem) => {
    const catalogue = structuredClone(watch);
    mutate(catalogue);
    const report = checkInventory(catalogue, inventory);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual(problem);
  });

  // why: IV3/IV18. When EVERY id of a module vanishes the report names the module, not N removed ids (the forgotten import).
  // proves: CLAIM(IV3) CLAIM(IV18)
  it("names a module whose declarations all vanished", () => {
    const catalogue = structuredClone(watch);
    catalogue.views = [];
    catalogue.examples = [];
    const report = checkInventory(catalogue, inventory);
    expect(report.problems).toContainEqual({ kind: "missing-module", module: "watch", ids: ["event.details", "watch.cancelled", "watch.events", "watch.pending", "watch.redelivered", "watch.status"] });
  });
});

describe("[IV14] coverage", () => {
  const run = (examples: Array<[string, string, boolean]>) => ({ examples: examples.map(([id, outcome, verified]) => ({ id, outcome, verified, attempts: ["i"], final: "i", priorFailures: [], suiteFailedAfter: [] })), invocations: [] }) as any;

  // why: IV14/IV18. declared, linked, exercised and passing are FOUR numbers; a view whose type has no example that ran is a named gap.
  // Three views are declared and linked; WatchFile has an example that ran and verified (so watch.status, watch.events pass); Event has
  // no example at all (event.details is a gap).
  // proves: CLAIM(IV14) CLAIM(IV18)
  it("reports declared, linked, exercised and passing separately with named gaps", () => {
    const result = coverage(watch, inventory, [run([["watch.pending", "passed", true]])]);
    expect(result).toEqual({ declared: 3, linked: 3, exercised: 2, passing: 2, gaps: [{ viewId: "event.details", reason: "no-example" }] });
  });

  // why: an example that ran and failed exercises the views of its type but does not make them passing.
  // proves: CLAIM(IV14)
  it("a failing example exercises but does not pass", () => {
    const result = coverage(watch, inventory, [run([["watch.pending", "failed", false]])]);
    expect(result).toMatchObject({ exercised: 2, passing: 0 });
    expect(result.gaps).toContainEqual({ viewId: "watch.status", reason: "not-passing" });
  });

  // why: no run at all: nothing is exercised and the gaps say never-run (not "no example").
  // proves: CLAIM(IV14)
  it("without runs nothing is exercised", () => {
    const result = coverage(watch, inventory, []);
    expect(result).toMatchObject({ declared: 3, linked: 3, exercised: 0, passing: 0 });
    expect(result.gaps).toContainEqual({ viewId: "watch.status", reason: "never-run" });
  });
});
