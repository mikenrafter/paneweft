// S5: inter-PROCESS session writes. Every process opens the session directory (orchestrator default after red 2: no private
// endpoint), so mutual exclusion between processes is the lock's job, and only real separate processes can test it: two
// in-process handles share one event loop and one JavaScript heap, and the hook-based tests in session.atomic.test.ts
// cannot interleave two writers. Method: test/helpers/proc-barrier.ts starts two `node --import tsx` children, each
// of which stops INSIDE the critical section (Session test hook beforeManifestSwap) until the parent releases it.
//   - with mutual exclusion the second child cannot get inside while the first is there (reachedBeforeFirstRelease = 1);
//   - without it both are inside at once, both read the same manifest, and the second write silently replaces the first.
// The outcome assertions below are what a lost update looks like, so the test fails for a missing lock for two independent
// reasons (the barrier count and the lost data). Mutation record: docs/contract-additions/round2.md "S5 mutation".
// Real time: the passing case spends GRACE_MS (1 s) per test waiting for the second process to prove it is excluded.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRACE_MS, runBarriered } from "../../test/helpers/proc-barrier.ts";
import { clone } from "../../test/helpers/fixtures.ts";
import { must } from "../../test/helpers/must.ts";
import { bundleFixture, importAll, openOk, subBundle } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();

describe("session: two real processes writing the same directory", () => {
  // why: S5. Two processes import DIFFERENT valid views into one session at the same moment. Both must succeed and BOTH views must be
  //   stored: a lost update (the second manifest swap replacing the first) leaves one view. The barrier proves the exclusion directly:
  //   exactly one process is inside the critical section when the first is released.
  // proves: CLAIM(S5-inter-process-lock) CLAIM(atomic-manifest) CLAIM(MC20)
  it("[S5] concurrent imports from two processes: serialised (one inside at a time), both stored, no lost update", async () => {
    const dir = join(tmp("proc-import"), "session");
    const bundlePath = (name: string, viewId: string) => {
      const bundle = clone(subBundle(["modules"]));
      bundle.views[0]!.id = viewId;
      const path = join(tmp("proc-import-files"), name);
      writeFileSync(path, JSON.stringify(bundle));
      return path;
    };
    const first = bundlePath("a.json", "modules-from-a");
    const second = bundlePath("b.json", "modules-from-b");
    await (await openOk(dir)).close(); // create the directory

    const run = await runBarriered(dir, join(tmp("proc-import-barrier"), "b"), [
      { id: "A", operation: { op: "import", bundleFile: first } },
      { id: "B", operation: { op: "import", bundleFile: second } },
    ]);

    expect(run.outcomes.map((o) => [o.id, o.exitCode, o.result?.ok, o.stderr.slice(0, 200)]), `events ${run.events.join(" ")}`).toEqual([
      ["A", 0, true, ""], ["B", 0, true, ""],
    ]);
    expect(run.reachedBeforeFirstRelease, `only one process may be inside the critical section (events: ${run.events.join(" ")}, grace ${GRACE_MS} ms)`).toBe(1);
    const after = await openOk(dir);
    expect((await after.listViews()).map((key) => key.viewId)).toEqual(["modules-from-a", "modules-from-b"]);
    await after.close();
  });

  // why: S5. The same race on a notebook revision: both processes update revision 1 of the page. Exactly ONE wins (revision 2) and the other
  //   gets CONFLICT with details.currentRevision 2 (store.md 15); a missing lock lets both pass the revision check and both write
  //   "revision 2" - two successes, one silently overwritten. The surviving content is the winner's, never a mix.
  // proves: CLAIM(S5-inter-process-lock) CLAIM(MC16)
  it("[S5] two processes update notebook revision 1: exactly one succeeds, the other is CONFLICT {currentRevision: 2}, the winner's blocks survive", async () => {
    const dir = join(tmp("proc-notebook"), "session");
    const session = await openOk(dir);
    await importAll(session);
    const page = must(await session.notebookGet("cancellation-notebook"), "notebookGet");
    expect(page.revision).toBe(1);
    await session.close();
    const blocksOf = (text: string) => {
      const blocks = clone((bundleFixture().views.find((view) => view.id === "cancellation-notebook")!.data as { blocks: any[] }).blocks);
      blocks[0].markdown = text;
      const path = join(tmp("proc-notebook-files"), `${text.replace(/\W/g, "")}.json`);
      writeFileSync(path, JSON.stringify(blocks));
      return { path, text };
    };
    const a = blocksOf("edit from process A");
    const b = blocksOf("edit from process B");

    const run = await runBarriered(dir, join(tmp("proc-notebook-barrier"), "b"), [
      { id: "A", operation: { op: "notebookUpdate", pageId: "cancellation-notebook", expectedRevision: 1, blocksFile: a.path } },
      { id: "B", operation: { op: "notebookUpdate", pageId: "cancellation-notebook", expectedRevision: 1, blocksFile: b.path } },
    ]);

    expect(run.reachedBeforeFirstRelease, `only one process may be inside the critical section (events: ${run.events.join(" ")})`).toBe(1);
    const results = run.outcomes.map((o) => o.result);
    expect(results.filter((r) => r?.ok === true), `outcomes ${JSON.stringify(run.outcomes.map((o) => [o.id, o.result, o.stderr.slice(0, 120)]))}`).toHaveLength(1);
    const loser = results.find((r) => r?.ok === false);
    expect(loser).toMatchObject({ ok: false, code: "CONFLICT", details: { currentRevision: 2 } });
    const winner = run.outcomes.find((o) => o.result?.ok === true)!.id === "A" ? a : b;
    const after = await openOk(dir);
    const latest = must(await after.notebookGet("cancellation-notebook"), "notebookGet latest");
    expect(latest.revision).toBe(2);
    expect((latest.envelope.data as { blocks: Array<{ markdown?: string }> }).blocks[0]?.markdown).toBe(winner.text);
    expect(must(await after.notebookGet("cancellation-notebook", 1), "revision 1 still readable").revision).toBe(1);
    await after.close();
  });
});
