// why: N1 (final spec review). The HTTP fixtures of S7 are hand-written answers of "a correct viewer server"; the shipped bundle is
//   tested against them, so a fixture that no real server could produce would let the bundle pass against a fiction. Every response
//   and the one request body are therefore validated against src/schemas/viewer-api.schema.json (raw Ajv, independent of src/core),
//   and the REAL viewer server's answers for the same data are validated against the same definitions and compared with the fixtures'
//   literal facts. Fixture and server cannot drift apart without one of these going red.
// proves: CLAIM(N1-http-schema) CLAIM(MC20)
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSchemaRegistry } from "../schemas/index.ts";
import { FIXTURES, clone, loadFixture } from "../../test/helpers/fixtures.ts";
import { bearer, jsonOf, rawRequest, useViewers } from "../../test/helpers/wire-http.ts";

const API = "urn:paneweft:schema:viewer-api:1";
const ajv = createSchemaRegistry();
function validator(definition: string) {
  const validate = ajv.getSchema(`${API}#/$defs/${definition}`);
  expect(validate, `${definition} is a definition of the viewer API schema`).toBeTypeOf("function");
  return validate!;
}
function accepts(definition: string, value: unknown): void {
  const validate = validator(definition);
  expect(validate(value), `${definition}: ${JSON.stringify(validate.errors)}`).toBe(true);
}
function rejects(definition: string, value: unknown): void {
  expect(validator(definition)(value), `${definition} should reject this value`).toBe(false);
}

/** Pinned by name (test-quality 8, "iterating over the current set"): every file of fixtures/http and the definition it answers to. */
const FIXTURE_SCHEMAS: Record<string, string> = {
  "index.json": "Index",
  "registry.json": "Registry",
  "entity.watch.json": "EntityRead",
  "entity.notes.json": "EntityRead",
  "entity.mcp.json": "EntityRead",
  "entity.mcp.decoy.json": "EntityRead",
  "view.modules.json": "ViewModel",
  "view.delivery-path.json": "ViewModel",
  "view.cancellation-notebook.json": "ViewModel",
  "view.cancellation-notebook.rev2.json": "ViewModel",
  "notebook.rev2.json": "NotebookPage",
  "notebook.request.json": "NotebookWrite",
};

describe("[N1] the committed HTTP fixtures answer to the viewer API schema", () => {
  it("[N1] every JSON file in fixtures/http is covered by the table above (a new fixture needs a definition)", () => {
    const files = readdirSync(join(FIXTURES, "http")).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual(Object.keys(FIXTURE_SCHEMAS).sort());
  });
  for (const [file, definition] of Object.entries(FIXTURE_SCHEMAS)) {
    it(`[N1] ${file} is a valid ${definition}`, () => accepts(definition, loadFixture(`http/${file}`)));
  }

  // why: negative controls - the schema must be able to say no to exactly the defects N1 names.
  it("[N1] /api/index without `entities` is rejected (entities are required)", () => {
    const index = clone(loadFixture<Record<string, unknown>>("http/index.json"));
    delete index.entities;
    rejects("Index", index);
  });
  it("[N1] a notebook view model without `notebookRevision` is rejected; a list view model carrying one is rejected too", () => {
    const notebook = clone(loadFixture<Record<string, unknown>>("http/view.cancellation-notebook.json"));
    delete notebook.notebookRevision;
    rejects("ViewModel", notebook);
    const list = clone(loadFixture<Record<string, unknown>>("http/view.modules.json"));
    list.notebookRevision = 1;
    rejects("ViewModel", list);
  });
  it("[N1] the notebook read fixtures carry the revision they were read at: 1 before the edit, 2 after", () => {
    expect(loadFixture<{ notebookRevision: number }>("http/view.cancellation-notebook.json").notebookRevision).toBe(1);
    expect(loadFixture<{ notebookRevision: number }>("http/view.cancellation-notebook.rev2.json").notebookRevision).toBe(2);
    expect(loadFixture<{ revision: number }>("http/notebook.rev2.json").revision).toBe(2);
  });
});

describe("[N1] the real viewer server answers with schema-valid bodies that match the fixtures' facts", () => {
  const viewers = useViewers();
  const get = async (route: string) => {
    const { server } = current!;
    return jsonOf(await rawRequest(server, route, { headers: bearer(server.token) }), route);
  };
  let current: Awaited<ReturnType<typeof viewers.start>> | null = null;
  const start = async () => (current = await viewers.start());
  const byViewId = (views: Array<{ viewId: string }>) => [...views].sort((a, b) => (a.viewId < b.viewId ? -1 : 1));

  it("[N1] /api/index is a valid Index equal to the fixture (entities and views, compared as sets sorted by id)", async () => {
    await start();
    const body = await get("/api/index");
    accepts("Index", body);
    const fixture = loadFixture<{ entities: Array<{ id: string }>; views: Array<{ viewId: string }> }>("http/index.json");
    expect(byViewId(body.views)).toEqual(byViewId(fixture.views));
    const byId = (list: Array<{ id: string }>) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(byId(body.entities)).toEqual(byId(fixture.entities));
  });

  it("[N1] /api/registry is a valid Registry holding the seven bundle definitions", async () => {
    await start();
    const body = await get("/api/registry");
    accepts("Registry", body);
    expect(body.definitions.map((definition: { id: string }) => definition.id).sort()).toEqual(
      ["def-delivery", "def-example", "def-layout", "def-modules", "def-shape", "def-source", "def-story"],
    );
  });

  it("[N1] /api/entity is a valid EntityRead for each entity; the ranking lists the definitions of the fixture", async () => {
    await start();
    for (const [id, kind, file] of [["watch", "vigil/watch", "entity.watch.json"], ["notes", "notes/page", "entity.notes.json"], ["mcp", "code/module", "entity.mcp.json"]] as const) {
      const body = await get(`/api/entity?snapshot=snap-1&repository=r&id=${id}&kind=${encodeURIComponent(kind)}`);
      accepts("EntityRead", body);
      const fixture = loadFixture<{ entity: unknown; views: { views: unknown[]; selected: unknown } }>(`http/${file}`);
      expect(body.entity, id).toEqual(fixture.entity);
      expect(body.views.selected, id).toEqual(fixture.views.selected);
      expect(body.views.views.map((view: { definitionId: string }) => view.definitionId), id).toEqual(fixture.views.views.map((view: any) => view.definitionId));
    }
  });

  it("[N1] /api/view is a valid ViewModel; the notebook carries notebookRevision 1, a list carries none; contentHash equals the fixture's literal", async () => {
    await start();
    for (const [viewId, file] of [["modules", "view.modules.json"], ["delivery-path", "view.delivery-path.json"], ["cancellation-notebook", "view.cancellation-notebook.json"]] as const) {
      const body = await get(`/api/view?viewId=${viewId}&snapshotId=snap-1`);
      accepts("ViewModel", body);
      const fixture = loadFixture<{ envelope: unknown; contentHash: string; notebookRevision?: number }>(`http/${file}`);
      expect(body.envelope, viewId).toEqual(fixture.envelope);
      expect(body.contentHash, viewId).toBe(fixture.contentHash);
      expect(body.notebookRevision, viewId).toBe(fixture.notebookRevision);
    }
  });

  it("[N1] the notebook write answers a valid NotebookPage and the next read carries notebookRevision 2 (the request is the committed fixture)", async () => {
    await start();
    const { server } = current!;
    const request = loadFixture<Record<string, unknown>>("http/notebook.request.json");
    accepts("NotebookWrite", request);
    const reply = await rawRequest(server, "/api/notebooks/cancellation-notebook/revisions", {
      method: "POST", headers: { ...bearer(server.token), "content-type": "application/json" }, body: JSON.stringify(request),
    });
    expect([200, 201]).toContain(reply.status);
    const page = jsonOf(reply);
    accepts("NotebookPage", page);
    expect(page.revision).toBe(2);
    const after = await get("/api/view?viewId=cancellation-notebook&snapshotId=snap-1");
    accepts("ViewModel", after);
    expect(after.notebookRevision).toBe(2);
    expect(after.envelope.data.blocks.map((block: { id: string }) => block.id)).toEqual(["b2", "b1"]);
  });
});
