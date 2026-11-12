// Where a failed example is reported (F10, F30c). In the field test a failed `check_eq!` at src/watch.rs:1497 was reported at src/watch.rs:1505, the `panic!` of ANOTHER test
// in the same log: the check panics inside the SDK, so the host took the first `src/...` panic location it found. The check now records its own call site and the host uses it.
import { cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeV1Operation } from "./tools.ts";
import { createJobService } from "./jobs.ts";
import { FIXTURES, fakeCargoAdapter, makeRepo, seedToolSession, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();

const OTHER_TESTS_PANIC = "---- tests::paneweft_example_watch_panics stdout ----\nthread 'tests::paneweft_example_watch_panics' panicked at src/watch.rs:1505:9:\nseeded panic that is not a check\n";
const OWN_PANIC = "---- tests::paneweft_example_watch_pending stdout ----\nthread 'tests::paneweft_example_watch_pending' panicked at src/watch.rs:1497:9:\ncheck C failed\n";

async function failedSource(scenario: Record<string, unknown>) {
  const { session, dir } = await open();
  const root = tmp("loc-root");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  makeRepo(root, {});
  const qex = fake();
  const adapter = fakeCargoAdapter({ workspaceRoot: root });
  await seedToolSession(dir, session, root, adapter);
  qex.scenario({ mode: "fail", ...scenario });
  const jobs = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], env: qex.env });
  must(await jobs.collect({ requestId: "loc-1", repo: "vg", adapter: "cargo", examples: ["watch.pending"] }), "collect");
  const done = await vi.waitFor(async () => { const s = must(await jobs.status("loc-1", { waitSeconds: 5 }), "status"); expect(["succeeded", "failed"]).toContain(s.state); return s; }, { timeout: 60_000, interval: 100 });
  const diagnostic = JSON.parse((await executeV1Operation({ session, sessionDir: dir, jobs }, "explain_failure", { format: "json", diagnostic: done.diagnosticIds[0] })).body).items[0];
  return diagnostic;
}

describe("[F10] the location of a failed check", () => {
  // why: F10. The failing check recorded src/watch.rs:1497 and the log holds another test's panic at 1505 first; the diagnostic must name 1497.
  // proves: CLAIM(F10-check-site)
  it("uses the call site the check recorded, not a panic of another test in the log", async () => {
    const diagnostic = await failedSource({ checkSource: { path: "src/watch.rs", line: 1497 }, extraLog: OTHER_TESTS_PANIC });
    expect(diagnostic).toMatchObject({ category: "assertion", exampleId: "watch.pending", source: { path: "src/watch.rs", line: 1497 } });
  });

  // why: F10. An SDK that records no site (the check was made by `check()` with plain text, or by an older SDK): the panic of THIS test is used when the log has one,
  // identified by the thread name, and another test's panic never is.
  // proves: CLAIM(F10-own-panic-only)
  it("without a recorded site takes the panic of the same test, found by its thread name", async () => {
    const diagnostic = await failedSource({ extraLog: `${OTHER_TESTS_PANIC}${OWN_PANIC}` });
    expect(diagnostic.source).toEqual({ path: "src/watch.rs", line: 1497 });
  });

  // why: F10. Only another test's panic is in the log: the diagnostic falls back to the declaration of the example and does not borrow that line.
  // proves: CLAIM(F10-own-panic-only)
  it("never borrows a location from another test", async () => {
    const diagnostic = await failedSource({ extraLog: OTHER_TESTS_PANIC });
    expect(diagnostic.source, "the declaration of watch.pending in the catalogue, not line 1505 of another test").toEqual({ path: "src/watch.rs", line: 128 });
  });
});
