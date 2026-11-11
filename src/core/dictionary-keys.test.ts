// Review S5: dictionaries keyed by caller-controlled strings were plain objects. Canonicalising into `{}` dropped an own "__proto__" member
// (the assignment sets the prototype), so two different documents hashed alike and a recorded file hash was lost; snapshot lookups
// (`manifest.snapshots[id]`) accepted inherited names such as "constructor"; a runner `{param:constructor}` was "supplied" by Object's constructor.
// These tests drive the real paths: canonical JSON and hashing, import/reopen/lookup in a Session, a real runner start, a rendered list row.
// Expected values are hand-derived: code-unit order puts "_" (0x5F) before "a" (0x61), so `__proto__` sorts before `b`.
// proves: CLAIM(own-keys)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.ts";
import { canonicalSha256 } from "./digest.ts";
import { executeOperation } from "./operations.ts";
import { runExample } from "./runner.ts";
import { must } from "../../test/helpers/must.ts";
import { bundleOf, complete, listView, row } from "../../test/helpers/ops-views.ts";
import { EXAMPLE_KEY, runnerDefinition, writeRegistry } from "../../test/helpers/store-runner.ts";
import { bundleFixture, importAll, inSnapshot, openOk } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const parsed = (text: string): any => JSON.parse(text); // JSON.parse creates an OWN "__proto__" member, the shape an attacker submits

describe("[S5] canonical JSON and hashing keep an own __proto__ member", () => {
  it("canonicalises {\"b\":1,\"__proto__\":{\"z\":2,\"y\":1}} to the literal with __proto__ first and its keys sorted", () => {
    expect(canonicalJson(parsed('{"b":1,"__proto__":{"z":2,"y":1}}'))).toBe('{"__proto__":{"y":1,"z":2},"b":1}');
  });

  it("two documents that differ only in the __proto__ member hash differently, and equal ones hash alike", () => {
    const one = parsed('{"__proto__":{"x":1},"a":2}');
    const other = parsed('{"__proto__":{"x":2},"a":2}');
    const same = parsed('{"a":2,"__proto__":{"x":1}}');
    expect(canonicalSha256(one)).not.toBe(canonicalSha256(other));
    expect(canonicalSha256(one)).toBe(canonicalSha256(same));
    expect(canonicalSha256(one)).not.toBe(canonicalSha256({ a: 2 }));
  });

  // control: ordinary keys are unchanged by whatever fixes the above.
  it("control: ordinary keys sort by code unit and nested arrays keep their order", () => {
    expect(canonicalJson({ b: [3, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[3,{"c":2,"d":1}]}');
  });
});

describe("[S5] a stored dictionary keyed by __proto__ survives import, reopen and lookup", () => {
  // why: freshness.files maps a repository-relative path to its hash; a file named __proto__ is a legal path. Losing the entry made
  //      freshness say "fresh" for a file nobody recorded.
  it("a recorded file hash under the key __proto__ is stored, reopened and part of the content hash", async () => {
    const dir = tmp("dict-files");
    const withFile = bundleFixture();
    const files = withFile.views[0]!.freshness.repositories[0]!.files;
    const sha = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
    Object.defineProperty(files, "__proto__", { value: sha, enumerable: true, configurable: true, writable: true });
    const first = await openOk(dir);
    const summary = must(await first.importBundle(withFile));
    const viewId = withFile.views[0]!.id;
    const plain = bundleFixture();
    expect(summary.contentHashes[`${viewId}@${withFile.views[0]!.snapshotId}`], "the member is part of the identity of the view").not.toBe(canonicalSha256(plain.views[0]));
    await first.close();
    const reopened = await openOk(dir);
    const stored = must(await reopened.getView({ viewId, snapshotId: withFile.views[0]!.snapshotId })).envelope;
    const reread = stored.freshness.repositories[0]!.files;
    expect(Object.getOwnPropertyDescriptor(reread, "__proto__")?.value).toBe(sha);
    await reopened.close();
  });

  // why: manifest.snapshots is keyed by the caller's snapshotId. "__proto__" was assigned as a prototype and vanished; "constructor"
  //      and "toString" were found as inherited functions.
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("snapshot %s: unknown before import, a real snapshot with no predecessor after import and reopen", async (name) => {
    const dir = tmp("dict-snapshots");
    const session = await openOk(dir);
    expect(await session.snapshotInfo(name), "before any import the name is not a snapshot").toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    must(await session.importBundle(inSnapshot(bundleFixture(), name)));
    await session.close();
    const reopened = await openOk(dir);
    const info = must(await reopened.snapshotInfo(name));
    expect(info.snapshotId).toBe(name);
    expect(info.predecessor).toBeNull();
    expect(info.viewIds.length).toBeGreaterThan(0);
    expect((await reopened.listViews()).every((key) => key.snapshotId === name)).toBe(true);
    await reopened.close();
  });

  it("an inherited name is not a predecessor: importing after predecessorSnapshotId \"constructor\" is NOT_FOUND and stores nothing", async () => {
    const session = await openOk(tmp("dict-predecessor"));
    const refused = await session.importBundle(inSnapshot(bundleFixture(), "snap-2"), { predecessorSnapshotId: "constructor" });
    expect(refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await session.listViews()).toEqual([]);
    await session.close();
  });
});

describe("[S5] other caller-keyed dictionaries use own properties only", () => {
  // why: `{param:constructor}` was judged supplied because "constructor" in {} is true, and the function's source text became an argv element.
  it("a runner argv placeholder {param:constructor} with no such parameter is a REQUIRED issue and no process starts", async () => {
    const base = tmp("dict-runner");
    const workspace = join(base, "ws");
    mkdirSync(workspace);
    const session = await openOk(join(base, "s"));
    await importAll(session);
    const definition = runnerDefinition("pass-runner.mjs", workspace);
    const registry = writeRegistry(join(base, "registry"), [{ ...definition, argv: [...definition.argv, "{param:constructor}"] }]);
    const result = await runExample(session, { runnerRegistryFile: registry, runnerId: definition.id, parameters: {}, key: EXAMPLE_KEY });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", errors: [{ code: "REQUIRED", pointer: "/parameters/constructor" }] } });
    await session.close();
  });

  // why: the first column's key names a cell the row does not have; `cells["constructor"]` is Object's constructor, whose source text was printed.
  it("a list whose first column key is \"constructor\" shows the row label, not Object's source text, for a row without that cell", async () => {
    const dir = tmp("dict-cells");
    const session = await openOk(dir);
    const view = listView({
      id: "ctor", snapshotId: "snap-1", definitionId: "def-ctor", title: "Ctor", completeness: complete("one row"),
      columns: [{ key: "constructor", title: "Constructor", format: "text" }],
      order: { key: "constructor", direction: "asc" },
      rows: [row("r1", {}, { label: "row-one-label" })],
    });
    must(await session.importBundle(bundleOf([view])));
    const outcome = await executeOperation(session, "inspect_view", { viewId: "ctor", snapshotId: "snap-1" });
    expect(outcome.ok, outcome.body).toBe(true);
    expect(outcome.body).toContain("row-one-label");
    expect(outcome.body).not.toContain("native code");
    await session.close();
  });
});
