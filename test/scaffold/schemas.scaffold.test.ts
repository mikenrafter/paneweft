// why: the red-phase tests are only fair if the committed schemas and fixtures are consistent with each
// other. This suite validates them with RAW Ajv, independent of src/core (which is still a stub), so a
// fixture that no implementation could satisfy is caught here, not in the green phase.
// scope: scaffold self-check. These tests are green by design in the red phase; they are counted
// separately in the red report and must stay green forever.
import { describe, expect, it } from "vitest";
import { createSchemaRegistry } from "../../src/schemas/index.ts";
import { COMPONENT_IDS, TOOL_NAMES, loadSchemaDocuments } from "../../src/schemas/index.ts";
import { V0_COMPONENTS, allBundle, componentFixture } from "../helpers/fixtures.ts";

const envelopeId = "urn:paneweft:schema:envelope:1";
const bundleId = "urn:paneweft:schema:bundle:1";

describe("scaffold: schemas compile under Ajv 2020-12 strict", () => {
  const ajv = createSchemaRegistry();
  const documents = loadSchemaDocuments();

  it("registers every schema document, each declaring draft 2020-12 and a urn:paneweft $id", () => {
    // 3 + 7 components + 13 tools + (common, envelope, bundle, entity, definition, run-output, error, reply) = 28
    expect(documents).toHaveLength(28);
    for (const entry of documents) {
      expect(entry.document.$schema, entry.file).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(entry.id, entry.file).toMatch(/^urn:paneweft:schema:/);
    }
  });
  it("has exactly the seven v0 component schemas and thirteen tool schemas", () => {
    expect([...COMPONENT_IDS]).toEqual([...V0_COMPONENTS]);
    expect(TOOL_NAMES).toHaveLength(13);
    for (const tool of TOOL_NAMES) expect(documents.some((d) => d.file === `tools/${tool}.schema.json`), tool).toBe(true);
  });
  it("compiles the envelope and bundle schemas (all $refs resolve)", () => {
    expect(ajv.getSchema(envelopeId)).toBeTypeOf("function");
    expect(ajv.getSchema(bundleId)).toBeTypeOf("function");
  });

  describe("every component fixture validates against the envelope schema", () => {
    for (const component of V0_COMPONENTS) {
      it(`${component}`, () => {
        const validate = ajv.getSchema(envelopeId)!;
        const fixture = componentFixture(component);
        expect(fixture.component).toBe(component);
        const ok = validate(fixture);
        expect(ok, JSON.stringify(validate.errors)).toBe(true);
      });
    }
  });
  it("all.bundle.json validates and its views equal the component fixtures (no drift)", () => {
    const validate = ajv.getSchema(bundleId)!;
    const bundle = allBundle();
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.views.map((v: any) => v.component)).toEqual([...V0_COMPONENTS]);
    for (const component of V0_COMPONENTS) {
      expect(bundle.views.find((v: any) => v.component === component)).toEqual(componentFixture(component));
    }
  });

  describe("negative controls: the schemas reject what they must", () => {
    const validate = ajv.getSchema(envelopeId)!;
    it("rejects a graph with a string depth", () => {
      const graph = structuredClone(componentFixture("graph"));
      graph.data.focus = { node: "a", direction: "out", depth: "2" };
      expect(validate(graph)).toBe(false);
      expect(validate.errors?.some((e) => e.instancePath === "/data/focus/depth" && e.keyword === "type")).toBe(true);
    });
    it("rejects an unknown component and an unknown property", () => {
      const list = structuredClone(componentFixture("list"));
      list.component = "heatmap";
      expect(validate(list)).toBe(false);
      const extra = structuredClone(componentFixture("list"));
      extra.data.rows[0].colour = "red";
      expect(validate(extra)).toBe(false);
    });
    it("rejects an inferred item without reason/basis", () => {
      const list = structuredClone(componentFixture("list"));
      list.data.rows[0].provenance = "inferred";
      expect(validate(list)).toBe(false);
    });
  });
});
