// Registration through the explicit import manifest (IV3): sorted catalogue independent of module order, duplicate ids name both
// sources, a declared module that was not imported is a problem. The manifest under test is the fixture package's own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileCatalogue, defineManifest } from "./index.ts";
import { manifest } from "../../../fixtures/packages/containmarks-lite/paneweft.views.ts";
import { Mapping, mappingDetails } from "../../../fixtures/packages/containmarks-lite/src/mappings/containerMappings.paneweft.ts";
import { workMapping } from "../../../fixtures/packages/containmarks-lite/tests/mappings.examples.ts";
import { REPO_ROOT } from "../../../test/helpers/fixtures.ts";
import { call } from "../test/support.ts";

const FIXTURE = join(REPO_ROOT, "fixtures/packages/containmarks-lite");
const lineOf = (file: string, needle: string): number => readFileSync(join(FIXTURE, file), "utf8").split("\n").findIndex((line) => line.includes(needle)) + 1;

describe("[IV3] manifest catalogue", () => {
  // why: IV3. The compiled catalogue lists the type, its view and the four examples, sorted by id, with source locations that point
  // at the defining call (found by scanning the fixture, independent of the compiler) and the vitest selector (the test title).
  // proves: CLAIM(IV3) CLAIM(IV14)
  it("compiles types, views and examples sorted by id with source lines and selectors", () => {
    const result = call(() => compileCatalogue(manifest), "compileCatalogue");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const catalogue = result.catalogue as any;
    expect(catalogue.types).toEqual([{ typeId: "containmarks::ContainerMappingRecord", source: { path: "src/models.ts", symbol: "ContainerMappingRecord" } }]);
    expect(catalogue.views).toEqual([
      { id: "mapping.card", typeId: "containmarks::ContainerMappingRecord", title: "Mapping card", question: "Which original index and container does this mapping preserve?", component: "custom", priority: 20, module: "src/mappings/containerMappings.paneweft.ts", source: { path: "src/mappings/containerMappings.paneweft.ts", line: lineOf("src/mappings/containerMappings.paneweft.ts", "export const mappingCard = Mapping.view(") } },
      { id: "mapping.details", typeId: "containmarks::ContainerMappingRecord", title: "Container mapping", question: "Which original index and container does this mapping preserve?", component: "shape", priority: 10, module: "src/mappings/containerMappings.paneweft.ts", source: { path: "src/mappings/containerMappings.paneweft.ts", line: lineOf("src/mappings/containerMappings.paneweft.ts", "export const mappingDetails = Mapping.view(") } },
    ]);
    expect(catalogue.examples.map((e: any) => e.id)).toEqual(["mapping.dead-end.naive-split", "mapping.renamed", "mapping.work", "mapping.zero-check"]);
    const work = catalogue.examples.find((e: any) => e.id === "mapping.work");
    expect(work).toEqual({ id: "mapping.work", typeId: "containmarks::ContainerMappingRecord", claims: ["CM1"], kind: "example", composes: [], module: "tests/mappings.examples.ts", source: { path: "tests/mappings.examples.ts", line: lineOf("tests/mappings.examples.ts", "export const workMapping = example(") }, selector: { runner: "vitest", name: "example:mapping.work" } });
    expect(catalogue.examples.find((e: any) => e.id === "mapping.dead-end.naive-split").kind).toBe("dead-end");
  });

  // why: IV3. The catalogue must not depend on module order in the manifest (digest stability).
  // proves: CLAIM(IV3)
  it("is independent of module order", () => {
    const reversed = defineManifest({ ...manifest, modules: [...manifest.modules].reverse() });
    const one = call(() => compileCatalogue(manifest), "forward");
    const two = call(() => compileCatalogue(reversed), "reversed");
    expect(one.ok && two.ok).toBe(true);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  // why: IV3. Two modules declaring one id report BOTH module paths, so the author can find the second.
  // proves: CLAIM(IV3)
  it("a duplicate view id names both sources", () => {
    const duplicated = defineManifest({ runners: ["vitest"], modules: [{ path: "a.paneweft.ts", types: [Mapping], views: [mappingDetails] }, { path: "b.paneweft.ts", views: [mappingDetails] }] });
    const result = call(() => compileCatalogue(duplicated), "compile duplicate");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([{ kind: "duplicate-id", id: "mapping.details", sources: [{ path: "a.paneweft.ts" }, { path: "b.paneweft.ts" }] }]);
  });

  // why: IV3/IV18. A forgotten manifest import is invisible to the compiler; declaring the expected module paths makes it an error
  // that names the missing module.
  // proves: CLAIM(IV3) CLAIM(IV18)
  it("a declared module that is not in the manifest is a missing-import problem", () => {
    const partial = defineManifest({ runners: ["vitest"], modules: [{ path: "src/mappings/containerMappings.paneweft.ts", types: [Mapping], views: [mappingDetails] }] });
    const result = call(() => compileCatalogue(partial, ["src/mappings/containerMappings.paneweft.ts", "tests/mappings.examples.ts"]), "compile partial");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([{ kind: "missing-import", id: "tests/mappings.examples.ts", sources: [] }]);
  });

  // why: an example whose type was never declared by any module is an unknown-type problem, not a catalogue entry that dangles.
  // proves: CLAIM(IV3)
  it("an example of an undeclared type is an unknown-type problem", () => {
    const orphan = defineManifest({ runners: ["vitest"], modules: [{ path: "tests/mappings.examples.ts", examples: [workMapping] }] });
    const result = call(() => compileCatalogue(orphan), "compile orphan");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => [p.kind, p.id])).toEqual([["unknown-type", "containmarks::ContainerMappingRecord"]]);
  });
});
