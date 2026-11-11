// The agent path through the CLI as separate processes, with a fake qex on PATH and a fake cargo as the adapter executable
// (deterministic, seconds). The acceptance test follows the agent path: manually assembling a bundle does not count (spec section 9).
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnPaneweft } from "../helpers/cli.ts";
import { FIXTURES, fakeCargoAdapter, git, makeRepo, useFakeQex } from "../helpers/v1-world.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const tmp = useTempDirs();
const fake = useFakeQex();

describe("[IV22 groundwork] the loop through the CLI", () => {
  // why: spec section 6 working loop, deterministic form. Owner setup (adapter, root), refresh the catalogue, discover, scaffold
  // (writes nothing), collect a passing example and a seeded failure, follow the job, explain the failure. Each step is a real process.
  // proves: CLAIM(IV14) CLAIM(IV15) CLAIM(IV16) CLAIM(IV17) CLAIM(IV19) CLAIM(IV22-recipe)
  it("walks discovery, scaffolding, collection, status and failure explanation", async () => {
    const qex = fake();
    const session = tmp("agent-session");
    const root = tmp("agent-root");
    cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
    makeRepo(root, {});
    const adapterFile = join(session, "..", `adapter-${Date.now()}.json`);
    writeFileSync(adapterFile, JSON.stringify(fakeCargoAdapter({ workspaceRoot: root })));
    const env = qex.env as Record<string, string>;
    const run = (args: string[]) => spawnPaneweft(["--session", session, ...args], { env });
    const json = async (args: string[]) => { const r = await run([...args, "--format", "json"]); return { ...r, body: r.stdout.trim() === "" ? null : JSON.parse(r.stdout) }; };

    expect((await run(["adapter", "add", "--file", adapterFile])).exitCode, "owner registers the adapter").toBe(0);
    expect((await run(["repo", "add", `vg=${root}`])).exitCode).toBe(0);
    const refresh = await run(["catalogue", "refresh", "--repo", "vg", "--adapter", "cargo"]);
    expect(refresh.exitCode, refresh.stdout + refresh.stderr).toBe(0);

    const types = await json(["types", "--repo", "vg"]);
    expect(types.body.items.map((t: any) => t.typeId)).toEqual(["vigil::watch::Event", "vigil::watch::WatchFile"]);
    expect(types.body.freshness.status).toBe("fresh");
    const views = await json(["views", "--repo", "vg", "--type", "vigil::watch::WatchFile"]);
    expect(views.body.items.map((v: any) => v.id)).toEqual(["watch.status", "watch.events"]);
    const examples = await json(["examples", "--repo", "vg", "--type", "vigil::watch::WatchFile"]);
    expect(examples.body.items.map((e: any) => e.id)).toEqual(["watch.cancelled", "watch.pending", "watch.redelivered"]);

    const before = git(root, "status", "--porcelain");
    const scaffold = await json(["scaffold", "view", "--repo", "vg", "--type", "vigil::watch::WatchFile", "--question", "Which events survive?"]);
    expect(scaffold.exitCode, scaffold.stdout).toBe(0);
    expect(git(root, "status", "--porcelain"), "scaffolding wrote nothing").toBe(before);

    const started = await json(["collect", "--request-id", "e1", "--repo", "vg", "--adapter", "cargo", "--example", "watch.pending"]);
    expect(started.exitCode, started.stdout).toBe(0);
    const done = await json(["collection", "status", "e1", "--wait-seconds", "30"]);
    expect(done.body.items[0]).toMatchObject({ state: "succeeded", runId: "run-e1", collectionStatus: "succeeded" });

    qex.scenario({ mode: "fail" });
    expect((await json(["collect", "--request-id", "e2", "--repo", "vg", "--adapter", "cargo", "--example", "watch.pending"])).exitCode).toBe(0);
    const failed = await json(["collection", "status", "e2", "--wait-seconds", "30"]);
    expect(failed.body.items[0]).toMatchObject({ state: "failed", collectionStatus: "failed" });
    const diagnostic = failed.body.items[0].diagnosticIds[0];
    expect(diagnostic).toBe("diag-inv-1");
    const explained = await json(["failure", diagnostic]);
    expect(explained.exitCode, explained.stdout).toBe(0);
    expect(explained.body.items[0]).toMatchObject({ id: "diag-inv-1", category: "assertion", exampleId: "watch.pending", selector: { examples: ["watch.pending"] }, basis: "stored-diagnostic" });
    expect(explained.body.items[0].nextAction).toContain("C");
    expect(qex.executions(), "two collections plus one catalogue refresh executed").toHaveLength(3);
  }, 180_000);
});
