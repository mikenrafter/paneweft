// "last outcome" and "last capture" in the discovery tools (field test F22, F11). Run ids come from request ids the agent chooses, so their
// string order says nothing about which run is newest; and a run that was cancelled before the example captured anything is not the last capture.
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../test/helpers/must.ts";
import { multiExampleImport } from "../../test/helpers/v1-runs.ts";
import { makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { importCollection } from "./import.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const toolWorld = makeToolWorld({ open, tmp, fake });

afterEach(() => void vi.useRealTimers());

/** Imports `input` at the wall-clock time `at` (the host stamps `meta.importedAt` from the clock; only Date is faked, so I/O and locks run normally). */
async function importAt(session: Parameters<typeof importCollection>[0], at: string, input: ReturnType<typeof multiExampleImport>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  must(await importCollection(session, input), `import ${input.runId}`);
  vi.useRealTimers();
}

describe("[F22] last is the newest run, not the greatest run id", () => {
  // why: F22. After `run-kill-1` (watch.slow killed) and the later `run-aaa-qexkill` (passed), `examples` said `last=error in run-kill-1`: the greatest
  // id. The run recorded last decides.
  // proves: CLAIM(F22-last-by-time)
  it("list_examples reports the outcome of the run recorded last", async () => {
    const { session, okCall, text } = await toolWorld();
    await importAt(session, "2026-11-12T09:00:00Z", multiExampleImport("run-zzz", [{ id: "watch.pending", outcome: "failed" }]));
    await importAt(session, "2026-11-12T10:00:00Z", multiExampleImport("run-aaa", [{ id: "watch.pending", outcome: "passed" }]));
    const { payload } = await okCall("list_examples", { repo: "vg" });
    const pending = payload.items.find((item: any) => item.id === "watch.pending");
    expect(pending.lastOutcome).toMatchObject({ runId: "run-aaa", outcome: "passed", verified: true });
    const line = (await text("list_examples", { repo: "vg" })).body.split("\n").find((l) => l.startsWith("watch.pending "));
    expect(line).toContain("last=passed verified in run-aaa");
  });

  // why: F22. The order must not depend on the order the runs were listed in either: the same two runs imported the other way round give the other answer.
  // proves: CLAIM(F22-last-by-time)
  it("follows the recorded time when the greater id is the older run", async () => {
    const { session, okCall } = await toolWorld();
    await importAt(session, "2026-11-12T09:00:00Z", multiExampleImport("run-aaa", [{ id: "watch.pending", outcome: "failed" }]));
    await importAt(session, "2026-11-12T10:00:00Z", multiExampleImport("run-zzz", [{ id: "watch.pending", outcome: "passed" }]));
    const pending = (await okCall("list_examples", { repo: "vg" })).payload.items.find((item: any) => item.id === "watch.pending");
    expect(pending.lastOutcome).toMatchObject({ runId: "run-zzz", outcome: "passed" });
  });

  // why: F22. The same ordering decides `last capture` in the views listing.
  // proves: CLAIM(F22-last-by-time)
  it("list_views_for_type names the newest capture", async () => {
    const { session, okCall } = await toolWorld();
    await importAt(session, "2026-11-12T09:00:00Z", multiExampleImport("run-zzz", [{ id: "watch.pending" }]));
    await importAt(session, "2026-11-12T10:00:00Z", multiExampleImport("run-aaa", [{ id: "watch.pending" }]));
    const { payload } = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    for (const item of payload.items) expect(item.lastCapture).toMatchObject({ runId: "run-aaa", snapshotId: "snap-run-aaa" });
  });
});

describe("[F11] a run that captured nothing is not the last capture", () => {
  // why: F11. A cancelled job (`v-3`) imported a run with no capture; `views` said `last capture=run-v-3` while earlier runs held the real captures.
  // proves: CLAIM(F11-last-capture)
  it("list_views_for_type skips a newer run whose example captured nothing", async () => {
    const { session, okCall, text } = await toolWorld();
    await importAt(session, "2026-11-12T09:00:00Z", multiExampleImport("run-1", [{ id: "watch.pending" }]));
    await importAt(session, "2026-11-12T10:00:00Z", multiExampleImport("run-2", [{ id: "watch.pending", outcome: "cancelled", capture: false }]));
    const { payload } = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    for (const item of payload.items) expect(item.lastCapture, item.id).toMatchObject({ runId: "run-1" });
    const body = (await text("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" })).body;
    expect(body).toContain("last capture=run-1");
    expect(body).not.toContain("last capture=run-2");
  });

  // why: F11. With no capture anywhere the answer is "never", not the id of a run that ran the example and produced nothing.
  // proves: CLAIM(F11-last-capture)
  it("says never when no run captured the type", async () => {
    const { session, okCall } = await toolWorld();
    await importAt(session, "2026-11-12T10:00:00Z", multiExampleImport("run-2", [{ id: "watch.pending", outcome: "cancelled", capture: false }]));
    const { payload } = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    for (const item of payload.items) expect(item.lastCapture, item.id).toBeNull();
  });
});
