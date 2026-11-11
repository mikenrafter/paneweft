// Fix round 1, S4: the qex client against what the real qex prints (fixtures/v1/qex-real, qex 0.33.0), not against the fake.
import { chmodSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { createQexClient, signalName } from "./qex.ts";

const tmp = useTempDirs();
const REAL = join(FIXTURES, "v1/qex-real");
const sample = (name: string): any => JSON.parse(readFileSync(join(REAL, name), "utf8"));

function replay(which: "ok" | "killed" | "segv") {
  const dir = tmp("qexreal");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(FIXTURES, "v1/bin/qex-real");
  chmodSync(script, 0o755);
  symlinkSync(script, join(bin, "qex"));
  const calls = join(dir, "calls.jsonl");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, QEX_REAL_CASE: which, QEX_REAL_CALLS: calls };
  const seen = (): string[][] => { try { return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
  return { client: createQexClient({ env }), seen };
}

describe("[S4] the client reads real qex records", () => {
  // why: S4. Real qex reports the signal as a NUMBER (killed job: signal 15, exit_code null). The client passed it through into the
  // string-only test-run schema, so a killed or timed-out collection could not be imported. Rejects the client that returns `job.signal` as given.
  // proves: CLAIM(S4-real-qex)
  it.each([["killed", "SIGTERM", "killed"], ["segv", "SIGSEGV", "failed"]] as const)("status of the %s job has the signal NAME %s", async (which, name, state) => {
    const { client } = replay(which);
    const job = must(await client.status(sample(`status-${which}.json`).id), "status");
    expect(job).toMatchObject({ state, exit_code: null, signal: name });
  });

  // why: S4. A job that exited normally keeps exit_code and has no signal.
  // proves: CLAIM(S4-real-qex)
  it("status of the ok job has its exit code and no signal", async () => {
    const { client } = replay("ok");
    expect(must(await client.status(sample("status-ok.json").id), "status")).toMatchObject({ state: "completed", exit_code: 0, signal: null });
  });

  // why: S4. `qex wait` without --json prints a line of text, so the client that omitted --json could never read a stopped job from wait and
  // always fell back to polling. The client asks for --json and decodes the ARRAY real qex answers with, whatever the exit code (125 killed,
  // 98 signal) says.
  // proves: CLAIM(S4-real-qex)
  it.each([["ok", "completed", null], ["killed", "killed", "SIGTERM"], ["segv", "failed", "SIGSEGV"]] as const)("wait decodes the %s job from the array real qex prints", async (which, state, signal) => {
    const { client, seen } = replay(which);
    const job = must(await client.wait(sample(`status-${which}.json`).id, 5000), "wait");
    expect(job, "the stopped job, decoded").toMatchObject({ id: sample(`status-${which}.json`).id, state, signal });
    expect(seen().find((argv) => argv[0] === "wait"), "wait asks for JSON").toContain("--json");
  });

  // why: S4. list shares the status record; one entry per job, signals named.
  // proves: CLAIM(S4-real-qex)
  it("list names the signals of every entry", async () => {
    const { client } = replay("ok");
    const jobs = must(await client.list(), "list");
    expect(jobs.map((job) => [job.state, job.signal])).toEqual([["completed", null], ["killed", "SIGTERM"], ["failed", "SIGSEGV"]]);
  });

  // why: S4. submit prints the bare job id on stdout.
  // proves: CLAIM(S4-real-qex)
  it("submit returns the id real qex prints", async () => {
    const { client } = replay("ok");
    expect(must(await client.submit(["submit", "--", "true"]), "submit").id).toBe(sample("submit.json").id);
  });

  // why: the name mapping itself: Linux signal numbers to the usual names, unknown numbers keep their number, strings pass through.
  // proves: CLAIM(S4-real-qex)
  it("signalName maps numbers to names", () => {
    expect([signalName(15), signalName(9), signalName(11), signalName(2), signalName(null), signalName("SIGINT"), signalName(250)]).toEqual(["SIGTERM", "SIGKILL", "SIGSEGV", "SIGINT", null, "SIGINT", "SIG250"]);
  });
});
