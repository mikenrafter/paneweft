// A job nobody polls (F20). In the field test the catalogue export finished in qex and, 20 s later, the job still said `running`: the run stage was submitted, and the results
// imported, only by the next `collection status`. Every test before this one polled, so every job advanced. Here the CLI runs as separate processes, as an agent's does: `collect`
// returns and exits, and nothing asks about the job again until the test looks at the files.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnPaneweft } from "../helpers/cli.ts";
import { FIXTURES, fakeCargoAdapter, makeRepo, useFakeQex } from "../helpers/v1-world.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const tmp = useTempDirs();
const fake = useFakeQex();

async function ownerSetup() {
  const qex = fake();
  const session = tmp("driver-session");
  const root = tmp("driver-root");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  makeRepo(root, {});
  const adapterFile = join(session, "..", `adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(adapterFile, JSON.stringify(fakeCargoAdapter({ workspaceRoot: root })));
  const env = qex.env as Record<string, string>;
  const run = (args: string[]) => spawnPaneweft(["--session", session, ...args], { env });
  expect((await run(["adapter", "add", "--file", adapterFile])).exitCode).toBe(0);
  expect((await run(["repo", "add", `vg=${root}`])).exitCode).toBe(0);
  const state = (id: string): any => (existsSync(join(session, "jobs", id, "state.json")) ? JSON.parse(readFileSync(join(session, "jobs", id, "state.json"), "utf8")) : undefined);
  return { qex, session, run, state };
}

describe("[F20] a job advances without anyone polling it", () => {
  // why: F20. `collect` on a repository with no stored catalogue is two qex jobs (the export, then the run it resolved) and an import. After `collect` exits nothing calls
  // `collection status`; the job must still reach `succeeded` with its run imported. The test reads only the files, so it cannot be the poll that drives the job.
  // proves: CLAIM(F20-driver)
  it("runs the export, the run stage and the import after collect has returned", async () => {
    const w = await ownerSetup();
    const started = await w.run(["collect", "--request-id", "d1", "--repo", "vg", "--adapter", "cargo", "--example", "watch.pending"]);
    expect(started.exitCode, started.stdout + started.stderr).toBe(0);
    const done = await vi.waitFor(() => {
      const state = w.state("d1");
      expect(state?.state, JSON.stringify(state)).toBe("succeeded");
      return state;
    }, { timeout: 60_000, interval: 250 });
    expect(done.terminal).toMatchObject({ collectionStatus: "succeeded", snapshotIds: ["snap-run-d1"] });
    expect(w.qex.jobs().map((job) => job.state), "the export and the run both ran").toEqual(["completed", "completed"]);
    expect(existsSync(join(w.session, "catalogues", "vg", "cargo.json")), "the export stored the catalogue").toBe(true);
    const status = await w.run(["collection", "status", "d1", "--format", "json"]);
    expect(JSON.parse(status.stdout).items[0]).toMatchObject({ state: "succeeded", runId: "run-d1" });
  }, 120_000);

  // why: F20 keeps cancel. A job a driver is following is cancelled from another process: the job ends `cancelled`, qex stops the run, and the driver, which holds the lease while it
  // follows, lets go and exits.
  // proves: CLAIM(F20-driver) CLAIM(T3-cancel-too-late)
  it("is still cancellable while a driver follows it, and the driver ends", async () => {
    const w = await ownerSetup();
    const heartbeat = join(tmp("driver-beat"), "beat");
    w.qex.scenario({ mode: "hang", heartbeatFile: heartbeat });
    expect((await w.run(["collect", "--request-id", "d2", "--repo", "vg", "--adapter", "cargo", "--example", "watch.pending"])).exitCode).toBe(0);
    await vi.waitFor(() => expect(w.state("d2")?.stage, "the driver moved the job to its run stage").toBe("run"), { timeout: 60_000, interval: 250 });
    await vi.waitFor(() => expect(w.state("d2")?.state).toBe("running"), { timeout: 30_000, interval: 250 });
    const cancel = await w.run(["collection", "cancel", "d2", "--format", "json"]);
    expect(cancel.exitCode, cancel.stdout + cancel.stderr).toBe(0);
    expect(JSON.parse(cancel.stdout).items[0]).toMatchObject({ outcome: "cancelled" });
    expect(w.state("d2")?.state).toBe("cancelled");
    const pid = (JSON.parse(readFileSync(join(w.session, "jobs", "d2", "driver.json"), "utf8")) as { pid: number }).pid;
    await vi.waitFor(() => expect(() => process.kill(pid, 0), "the driver exited").toThrow(), { timeout: 20_000, interval: 250 });
    mkdirSync(tmp("unused"), { recursive: true });
  }, 120_000);
});
