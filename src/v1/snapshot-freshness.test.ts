// One freshness answer per snapshot on every surface (field test F23). A collected view carries no v0 source anchors, so the v0 check found
// nothing to compare and `inspect`, `open`, `navigate` and the viewer said "fresh" for a snapshot that view_result (which compares the run's
// recorded input fingerprint) called stale.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeOperation } from "../core/operations.ts";
import { createSessionSource } from "../viewer/session-source.ts";
import { must } from "../../test/helpers/must.ts";
import { multiExampleImport } from "../../test/helpers/v1-runs.ts";
import { independentFingerprint, makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { importCollection } from "./import.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const toolWorld = makeToolWorld({ open, tmp, fake });

/** A run whose recorded input fingerprint is that of the real repository, imported; returns the view's keys. */
async function importedRun(options: { edit?: boolean; sampled?: "consistent-sampled" | "mixed-input" | "unverified"; fingerprint?: boolean } = {}) {
  const world = await toolWorld();
  const input = multiExampleImport("run-v-1", [{ id: "watch.pending" }]);
  const fingerprint = independentFingerprint(world.root);
  if (options.fingerprint !== false) (input.run as any).inputFingerprint = { digest: fingerprint.digest, memberCount: fingerprint.members.length, sampledConsistency: options.sampled ?? "consistent-sampled", members: fingerprint.members };
  must(await importCollection(world.session, input), "import");
  if (options.edit) {
    writeFileSync(join(world.root, "src/lib.rs"), "// edited after the collection\n");
    writeFileSync(join(world.root, "NEW.txt"), "added after the collection\n");
  }
  const result = (await world.okCall("view_result", { run: "run-v-1", view: "watch.events", format: "json" })).payload;
  return { ...world, key: { viewId: result.details.storedViewId as string, snapshotId: result.details.snapshotId as string }, entity: result.details.entity as { repository: string; id: string; kind: string }, rows: result.items as Array<{ id: string; entity: { kind: string; id: string; repository: string } | null }>, result };
}

const STALE = ["NEW.txt: added", "src/lib.rs: modified"];

describe("[F23] a stale collected snapshot is stale on every surface", () => {
  // why: F23. The repository changed after the collection. view_result said `stale (changed: paneweft.inventory.json: added, src/watch.rs: modified)`
  // while inspect, open, navigate and the viewer said `fresh`.
  // proves: CLAIM(F23-one-answer)
  it("view_result, inspect, open, navigate and the viewer agree", async () => {
    const world = await importedRun({ edit: true });
    expect(world.result.freshness).toMatchObject({ status: "stale", reasons: STALE });
    const row = world.rows.find((candidate) => candidate.entity !== null)!;
    const surfaces: Record<string, any> = {
      inspect_view: (await executeOperation(world.session, "inspect_view", { ...world.key, format: "json" })),
      open_entity: (await executeOperation(world.session, "open_entity", { entity: world.entity, snapshotId: world.key.snapshotId, format: "json" })),
      navigate: (await executeOperation(world.session, "navigate", { pane: { entity: world.entity, snapshotId: world.key.snapshotId, viewDefinitionId: "watch.events" }, itemId: row.id, format: "json" })),
    };
    for (const [name, outcome] of Object.entries(surfaces)) {
      expect(outcome.ok, `${name}: ${outcome.body.slice(0, 200)}`).toBe(true);
      const freshness = JSON.parse(outcome.body).freshness;
      expect(freshness.status, name).toBe("stale");
      expect(freshness.changedPaths, name).toEqual(["NEW.txt", "src/lib.rs"]);
    }
    // the text form of every surface carries the same line as view_result
    const line = `freshness: stale (changed: ${STALE.join(", ")})`;
    expect((await world.text("view_result", { run: "run-v-1", view: "watch.events" })).body).toContain(line);
    expect((await executeOperation(world.session, "inspect_view", { ...world.key, format: "text" })).body).toContain(line);
    const viewer = await createSessionSource(world.session).getView(world.key);
    expect(viewer.ok).toBe(true);
    if (viewer.ok) expect(viewer.value.freshness).toMatchObject({ status: "stale", changedPaths: [{ path: "NEW.txt", change: "added" }, { path: "src/lib.rs", change: "modified" }] });
  });

  // why: F23. Nothing changed: every surface says fresh (the unification must not turn a clean snapshot stale).
  // proves: CLAIM(F23-one-answer)
  it("an untouched repository is fresh on every surface", async () => {
    const world = await importedRun();
    expect(world.result.freshness.status).toBe("fresh");
    const inspected = JSON.parse((await executeOperation(world.session, "inspect_view", { ...world.key, format: "json" })).body);
    expect(inspected.freshness.status).toBe("fresh");
    const viewer = await createSessionSource(world.session).getView(world.key);
    expect(viewer.ok && viewer.value.freshness.status).toBe("fresh");
  });

  // why: F23. A run with no recorded fingerprint, or one sampled while the checkout changed, cannot be called fresh by any surface: unverified, with the reason.
  // proves: CLAIM(F23-one-answer) CLAIM(S14)
  it.each([
    ["no recorded fingerprint", { fingerprint: false }, /no input fingerprint/],
    ["a mixed input sample", { sampled: "mixed-input" as const }, /checkout changed while this result was being produced/],
  ])("%s is unverified everywhere, with the reason", async (_name, options, reason) => {
    const world = await importedRun(options);
    expect(world.result.freshness.status).toBe("unverified");
    const inspected = JSON.parse((await executeOperation(world.session, "inspect_view", { ...world.key, format: "json" })).body);
    expect(inspected.freshness.status).toBe("unverified");
    expect(JSON.stringify(inspected.freshness.unverified)).toMatch(reason);
    const viewer = await createSessionSource(world.session).getView(world.key);
    expect(viewer.ok && viewer.value.freshness.status).toBe("unverified");
  });
});
