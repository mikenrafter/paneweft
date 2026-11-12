// S4 (review field r1): freshness of a collected run is judged through the adapter that collected it. Two adapters of one kind over two package directories of one
// repository used to be told apart by "the first adapter of the runner kind": a clean result could be called stale, and an edited package fresh.
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { must } from "../../test/helpers/must.ts";
import { multiExampleImport } from "../../test/helpers/v1-runs.ts";
import { independentFingerprint } from "../../test/helpers/v1-tool-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { FIXTURES, fakeCargoAdapter, makeRepo, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { importCollection } from "./import.ts";
import { createJobService } from "./jobs.ts";
import { executeV1Operation } from "./tools.ts";
import { collectedFreshness } from "./snapshot-freshness.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();

/** One repository R with two package directories a/ and z/, both copies of the same instrumented package, and one cargo adapter for each; z's collection has run. */
async function twoPackages() {
  const { session, dir } = await open();
  const root = tmp("two-packages");
  for (const name of ["a", "z"]) cpSync(join(FIXTURES, "crates/watchfile"), join(root, name), { recursive: true });
  makeRepo(root, {});
  must(await session.registerRepository({ id: "vg", root }), "register root");
  const adapters = [fakeCargoAdapter({ id: "a", workspaceRoot: root, entry: "a" }), fakeCargoAdapter({ id: "z", workspaceRoot: root, entry: "z" })];
  writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters }));
  const qex = fake();
  const service = createJobService({ session, sessionDir: dir, qex: qex.client, adapters, cancelWaitMs: 3000 });
  must(await service.collect({ requestId: "z-first", repo: "vg", adapter: "z", examples: ["watch.pending"] }), "collect");
  const done = await vi.waitFor(async () => { const view = must(await service.status("z-first"), "status"); expect(["succeeded", "failed"], JSON.stringify(view)).toContain(view.state); return view; }, { timeout: 20_000, interval: 50 });
  expect(done.state, JSON.stringify(done)).toBe("succeeded");
  const freshness = async () => (await collectedFreshness(session, "snap-run-z-first"))!;
  return { session, dir, root, freshness, adapters };
}

describe("[S4] a collected run is judged through the adapter that collected it", () => {
  // why: S4. z collected the run; a's package was edited afterwards. The run says nothing about a, but the freshness check compared its members with the FIRST adapter of the
  // kind (a): a clean result was called stale.
  // proves: CLAIM(S4-originating-adapter)
  it("an edit in the sibling package does not make the result stale", async () => {
    const w = await twoPackages();
    expect((await w.freshness()).status).toBe("fresh");
    writeFileSync(join(w.root, "a", "src", "lib.rs"), "// the sibling package changed\n");
    expect(await w.freshness()).toEqual({ status: "fresh" });
  });

  // why: S4. The other half: z's own source is edited while a is untouched (and was identical to z when z was collected). The check looked at a, saw nothing, and called the edited
  // package fresh.
  // proves: CLAIM(S4-originating-adapter)
  it("an edit in the collected package makes the result stale", async () => {
    const w = await twoPackages();
    writeFileSync(join(w.root, "z", "src", "lib.rs"), "// z changed after its collection\n");
    const answer = await w.freshness();
    expect(answer.status).toBe("stale");
    expect(JSON.stringify(answer)).toContain("src/lib.rs");
  });

  // why: S4. A run whose originating adapter cannot be identified (its job record is gone, or the adapter is no longer registered) is `unverified` and says why; it is never
  // judged against some other adapter's root.
  // proves: CLAIM(S4-originating-adapter)
  it("is unverified when the originating adapter cannot be identified", async () => {
    const lost = await twoPackages();
    rmSync(join(lost.dir, "jobs", "z-first", "intent.json"));
    const unknownJob = await lost.freshness();
    expect(unknownJob.status).toBe("unverified");
    expect(JSON.stringify(unknownJob)).toContain("adapter");

    const gone = await twoPackages();
    writeFileSync(join(gone.dir, "adapters.json"), JSON.stringify({ adapters: [gone.adapters[0]] }));
    const unregistered = await gone.freshness();
    expect(unregistered.status).toBe("unverified");
    expect(JSON.stringify(unregistered)).toContain("z");
  });

  // why: S4. `view_result` printed the recollect command with the first adapter of the run's kind: a result collected through z told the reader to recollect through a. The command and the
  // freshness line come from the same originating adapter.
  // proves: CLAIM(S4-originating-adapter)
  it("view_result names the originating adapter in its recollect command and judges the run through it", async () => {
    const w = await twoPackages();
    const input = multiExampleImport("run-z-import", [{ id: "watch.pending" }]);
    const fingerprint = independentFingerprint(join(w.root, "z"));
    (input.run as any).inputFingerprint = { digest: fingerprint.digest, memberCount: fingerprint.members.length, sampledConsistency: "consistent-sampled", members: fingerprint.members };
    input.jobId = "z-first";
    must(await importCollection(w.session, input), "import");
    const context = { session: w.session, sessionDir: w.dir, jobs: null };
    const read = async () => JSON.parse((await executeV1Operation(context, "view_result", { run: "run-z-import", view: "watch.events", format: "json" })).body);
    const fresh = await read();
    expect(fresh.freshness.status).toBe("fresh");
    expect(fresh.details.recollect.command).toContain("--adapter z ");
    writeFileSync(join(w.root, "z", "src", "lib.rs"), "// z changed\n");
    expect((await read()).freshness).toMatchObject({ status: "stale", reasons: ["src/lib.rs: modified"] });
  });
});
