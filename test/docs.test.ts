// why: dogfooding notes #1, #5 and the tier-2 note T15 are documentation faults: the schema catalogue lives in src/schemas/ and nothing said so (an agent looked for a
//   top-level schemas/); nothing told an author when a revised view needs a new definition id and when it reuses one; and the viewer's reload behaviour (the token
//   leaves the address bar, so a reload drops access) was unwritten. Prose cannot be proven, so the tests pin the headings and the claims a reader acts on, and the
//   revision recipe's claims are checked against the real session, so the README cannot drift from what the tool does.
// proves: CLAIM(readme-usage)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeOperation } from "../src/core/operations.ts";
import { openSession } from "../src/core/session.ts";
import { allBundle, clone, REPO_ROOT } from "./helpers/fixtures.ts";
import { must } from "./helpers/must.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tmp = useTempDirs();
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");
const README = read("README.md");
const markdownFiles = (): string[] => ["README.md", ...readdirSync(join(REPO_ROOT, "docs"), { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".md")).map((name) => join("docs", name))];

/** Text of a `###` subsection of the README (up to the next heading of level 2 or 3), or null. */
function subsection(heading: string): string | null {
  const lines = README.split("\n");
  const start = lines.findIndex((line) => line === `### ${heading}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3} /.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

describe("[#1] documents point at src/schemas/", () => {
  // why: the finding. A reader needs one sentence that says where the wire contracts are and which file answers which question.
  it("[#1] the README has a Schemas subsection naming src/schemas/, its components/ and tools/ directories and `describe`", () => {
    const text = subsection("Schemas");
    expect(text, "README has no '### Schemas' subsection").not.toBeNull();
    for (const needle of ["src/schemas/", "src/schemas/components/", "src/schemas/tools/", "bundle.schema.json", "envelope.schema.json", "describe"]) expect(text, needle).toContain(needle);
  });
  it("[#1] the design points at the schema directory too", () => {
    expect(read("docs/design.md")).toContain("`src/schemas/`");
  });
  // why: every schema path a document names must exist (a bare `schemas/` is the fault; a renamed file is its cousin).
  it("[#1] no document says a bare `schemas/`, and every `src/schemas/...` path a document names exists", () => {
    for (const file of markdownFiles()) {
      const text = read(file);
      expect(text.match(/(?<![\w/.-])schemas\//g) ?? [], `${file} names a top-level schemas/`).toEqual([]);
      for (const path of text.match(/src\/schemas\/[\w./*-]*/g) ?? []) {
        const concrete = path.replace(/[.,;:)]+$/, "");
        const directory = concrete.includes("*") ? concrete.slice(0, concrete.lastIndexOf("/")) : concrete;
        expect(existsSync(join(REPO_ROOT, directory)), `${file} names ${path}, which does not exist`).toBe(true);
      }
    }
  });
});

describe("[#5] the README says how to revise a view", () => {
  const section = subsection("Revise a view");
  // why: the finding: an author had to discover by trial that a definition id has one content for the whole session while a view is per snapshot.
  it("[#5] has a `Revise a view` subsection that separates facts, definition content and definition kind", () => {
    expect(section, "README has no '### Revise a view' subsection").not.toBeNull();
    for (const needle of ["new snapshot id", "reuse", "definition id", "register", "IDENTITY_CONFLICT", "SNAPSHOT_CONFLICT", "-v2", "validate"]) expect(section, needle).toContain(needle);
  });

  // The claims, checked against the tool. Session = all.bundle.json imported once (snapshot snap-1, definition def-modules: component list, entity kind vigil/watch).
  async function session() {
    const opened = must(await openSession(tmp("revise")));
    must(await opened.importBundle(allBundle()));
    return opened;
  }
  const call = (s: Awaited<ReturnType<typeof session>>, tool: string, args: unknown) => executeOperation(s, tool, args);
  const retag = (bundle: any, snapshotId: string) => {
    const copy = clone(bundle);
    for (const entity of copy.entities) entity.snapshotId = snapshotId;
    for (const view of copy.views) view.snapshotId = snapshotId;
    return copy;
  };

  // why: claim 1: only the facts changed -> new snapshot, same definition ids, and the registry does not move.
  it("[#5] claim: a new snapshot that reuses unchanged definition ids is accepted and leaves the registry revision alone", async () => {
    const s = await session();
    const before = (await s.listDefinitions()).revision;
    const second = retag(allBundle(), "snap-2");
    second.views[0].title = "Modules (revised)";
    const rendered = await call(s, "render", { input: second, format: "json" });
    expect(rendered.ok, rendered.body.slice(0, 300)).toBe(true);
    expect((await s.listDefinitions()).revision).toBe(before);
  });
  // why: claim 2: the same view key with other content is SNAPSHOT_CONFLICT (that is why the facts go in a new snapshot).
  it("[#5] claim: the same view id in the same snapshot with other content is SNAPSHOT_CONFLICT", async () => {
    const s = await session();
    const changed = clone(allBundle());
    changed.views[0].title = "Another title";
    const rendered = await call(s, "render", { input: changed, format: "json" });
    expect(rendered.ok ? "ok" : rendered.error.code).toBe("SNAPSHOT_CONFLICT");
  });
  // why: claim 3: a definition's own content (title, priority, requires, dataRole) is changed with `register` and the current registry revision; an import cannot.
  it("[#5] claim: an import with another title for a registered definition id is SNAPSHOT_CONFLICT; `register` with the current revision replaces it", async () => {
    const s = await session();
    const { revision, definitions } = await s.listDefinitions();
    const definition = { ...(definitions.find((d) => d.id === "def-modules") as object), title: "Modules v2 title" };
    const viaImport = await call(s, "render", { input: { schemaVersion: "paneweft.bundle/1", entities: [], definitions: [definition], views: [] }, format: "json" });
    expect(viaImport.ok ? "ok" : viaImport.error.code).toBe("SNAPSHOT_CONFLICT");
    const registered = await call(s, "register_view", { definition, expectedRevision: revision, format: "json" });
    expect(registered.ok, registered.body).toBe(true);
    expect((await s.listDefinitions()).revision).toBe(revision + 1);
  });
  // why: claim 4: a different component (or entity kind) under a registered id is IDENTITY_CONFLICT; a new id (`-v2`) is accepted.
  it("[#5] claim: a registered definition id with another component is IDENTITY_CONFLICT; the same definition under `<id>-v2` is accepted", async () => {
    const s = await session();
    const { definitions } = await s.listDefinitions();
    const original = definitions.find((d) => d.id === "def-modules") as object;
    const bundle = (definition: object) => ({ schemaVersion: "paneweft.bundle/1", entities: [], definitions: [definition], views: [] });
    const clash = await call(s, "render", { input: bundle({ ...original, component: "tree" }), format: "json" });
    expect(clash.ok ? "ok" : JSON.stringify(clash.error.errors.map((issue) => issue.code))).toContain("IDENTITY_CONFLICT");
    const versioned = await call(s, "render", { input: bundle({ ...original, id: "def-modules-v2", component: "tree" }), format: "json" });
    expect(versioned.ok, versioned.body.slice(0, 300)).toBe(true);
  });
});

describe("[T15] the README says a reload drops viewer access", () => {
  // why: the viewer keeps its token in memory only (it is stripped from the address bar at load), so a reload shows no data; the fix is to reopen the URL the
  //   CLI printed. The README must say both, next to `serve`.
  it("[T15] the viewer subsection says reloading drops access and to reopen the URL printed by serve or render", () => {
    const text = subsection("View in the browser");
    expect(text, "README has no '### View in the browser' subsection").not.toBeNull();
    expect(text).toMatch(/reload/i);
    expect(text).toMatch(/reopen the URL printed by `serve` or `render`/);
  });
});
