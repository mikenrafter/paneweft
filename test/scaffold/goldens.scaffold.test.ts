// why: the DOM goldens are only fair if their input bundles are valid under the committed schemas and the
// handful of semantic rules a viewer may rely on (unique ids, resolvable references, line counts, hashes).
// This validates fixtures/goldens/*.bundle.json with RAW Ajv plus a tiny independent semantic walk, so a
// fixture no implementation could satisfy is caught here, not in the green phase.
// scope: scaffold self-check, green by design in the red phase (counted separately in the red report).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSchemaRegistry } from "../../src/schemas/index.ts";
import { FIXTURES, loadFixture } from "../helpers/fixtures.ts";
import { sha256Hex } from "../helpers/hash.ts";

const BUNDLES = [
  "example-notrun", "example-runs", "filter", "graph", "hostile", "list", "nav", "notebook", "shape", "source", "tree",
] as const;
const GOLDEN_OUTLINES = [
  "example-notrun", "example-runs", "graph", "list", "notebook", "shape", "source", "tree",
] as const;
const bundleId = "urn:paneweft:schema:bundle:1";
const ajv = createSchemaRegistry();

describe("scaffold: DOM golden inputs", () => {
  it("lists exactly the committed bundle files (a new unregistered fixture must be added here)", () => {
    const found = readdirSync(join(FIXTURES, "goldens")).filter((n) => n.endsWith(".bundle.json")).map((n) => n.replace(".bundle.json", "")).sort();
    expect(found).toEqual([...BUNDLES]);
  });

  describe("every bundle validates against the bundle schema", () => {
    for (const name of BUNDLES) {
      it(name, () => {
        const validate = ajv.getSchema(bundleId)!;
        const bundle = loadFixture(`goldens/${name}.bundle.json`);
        expect(validate(bundle), JSON.stringify(validate.errors?.slice(0, 5))).toBe(true);
      });
    }
  });

  describe("semantic sanity independent of src/core", () => {
    for (const name of BUNDLES) {
      it(`${name}: unique item ids per view, resolvable evidence, edge endpoints, tree children, bundle view refs`, () => {
        const bundle = loadFixture<any>(`goldens/${name}.bundle.json`);
        const viewIds = new Set<string>(bundle.views.map((v: any) => v.id));
        expect(viewIds.size).toBe(bundle.views.length);
        for (const view of bundle.views) {
          const sourceIds = new Set<string>(view.sources.map((s: any) => s.id));
          const items: any[] = [];
          const d = view.data;
          if (view.component === "list") items.push(...d.rows);
          if (view.component === "tree") items.push(...d.nodes);
          if (view.component === "graph") items.push(...d.nodes, ...d.edges);
          if (view.component === "source") items.push(d.excerpt, ...d.annotations);
          if (view.component === "shape") items.push(...d.fields);
          if (view.component === "notebook") items.push(...d.blocks);
          if (view.component === "example") items.push(d.scenario, ...d.runs, ...d.runs.flatMap((r: any) => r.assertions));
          const ids = items.map((i) => i.id);
          expect(new Set(ids).size, `${view.id} duplicate ids`).toBe(ids.length);
          for (const item of items) for (const e of item.evidence) expect(sourceIds.has(e), `${view.id}/${item.id} evidence ${e}`).toBe(true);
          for (const item of items.filter((i) => i.provenance === "observed")) {
            expect(item.evidence.some((e: string) => view.sources.find((s: any) => s.id === e)?.runId !== undefined), `${view.id}/${item.id} observed needs a run`).toBe(true);
          }
          if (view.component === "graph") {
            const nodeIds = new Set(d.nodes.map((n: any) => n.id));
            for (const e of d.edges) { expect(nodeIds.has(e.from)).toBe(true); expect(nodeIds.has(e.to)).toBe(true); }
          }
          if (view.component === "tree") {
            const nodeIds = new Set(d.nodes.map((n: any) => n.id));
            for (const n of d.nodes) for (const c of n.children) expect(nodeIds.has(c), `${n.id} child ${c}`).toBe(true);
            for (const r of d.roots) expect(nodeIds.has(r)).toBe(true);
          }
          if (view.component === "source") {
            const [first, last] = d.excerpt.anchor.lines;
            expect(d.excerpt.text.split("\n").length, "excerpt line count equals its anchor range").toBe(last - first + 1);
            for (const a of d.annotations) { expect(a.lines[0]).toBeGreaterThanOrEqual(first); expect(a.lines[1]).toBeLessThanOrEqual(last); }
          }
          if (view.component === "notebook") {
            for (const b of d.blocks.filter((x: any) => x.kind === "view")) expect(viewIds.has(b.viewId), `embedded ${b.viewId}`).toBe(true);
            for (const b of d.blocks.filter((x: any) => x.kind === "claim")) {
              for (const t of [...b.supports, ...b.contradicts]) {
                if (typeof t === "string") expect(sourceIds.has(t)).toBe(true);
                else expect(viewIds.has(t.viewId), `claim target ${t.viewId}`).toBe(true);
              }
            }
          }
          if (view.component === "shape") {
            const fieldIds = new Set(d.fields.map((f: any) => f.id));
            expect(fieldIds.has(d.root)).toBe(true);
            for (const f of d.fields) { for (const c of f.children) expect(fieldIds.has(c)).toBe(true); if (f.ref !== undefined) expect(fieldIds.has(f.ref)).toBe(true); }
          }
        }
        const defIds = new Set<string>(bundle.definitions.map((x: any) => x.id));
        for (const view of bundle.views) expect(defIds.has(view.viewDefinitionId), `${view.id} definition`).toBe(true);
      });
    }
  });

  it("sha256 of fixtures/goldens/repo/src/check.ts equals the hash every bundle records for s1 (typo guard for the MC6 source tests)", () => {
    const bytes = readFileSync(join(FIXTURES, "goldens", "repo", "src", "check.ts"));
    expect(sha256Hex(bytes)).toBe("89e5381dc79ea9a770589a60d99cd7bed1d1a6cccba8195b1da5c716ea7c8bc2");
    expect(bytes.toString("utf8").split("\n")).toHaveLength(15); // 14 lines plus the empty string after the final newline
    expect(bytes.toString("utf8").split("\n").slice(9, 12).join("\n")).toBe(loadFixture<any>("goldens/source.bundle.json").views[0].data.excerpt.text);
    for (const name of BUNDLES) {
      const bundle = loadFixture<any>(`goldens/${name}.bundle.json`);
      for (const view of bundle.views) {
        expect(view.sources.find((s: any) => s.id === "s1").sha256).toBe("89e5381dc79ea9a770589a60d99cd7bed1d1a6cccba8195b1da5c716ea7c8bc2");
        expect(view.freshness.repositories[0].files["src/check.ts"]).toBe("89e5381dc79ea9a770589a60d99cd7bed1d1a6cccba8195b1da5c716ea7c8bc2");
      }
    }
  });

  it("every golden outline file exists and is non-empty (the DOM tests compare against them verbatim)", () => {
    for (const name of GOLDEN_OUTLINES) {
      const text = readFileSync(join(FIXTURES, "..", "test", "goldens", `${name}.outline.txt`), "utf8");
      expect(text.startsWith("viewer\n"), name).toBe(true);
      expect(text.endsWith("\n"), name).toBe(true);
    }
  });
});
