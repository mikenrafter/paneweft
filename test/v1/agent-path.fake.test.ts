// The agent path through the CLI as separate processes, with a fake qex on PATH and a fake cargo as the adapter executable
// (deterministic, seconds). The acceptance test follows the agent path: manually assembling a bundle does not count (spec section 9).
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { specLimits } from "../../packages/paneweft-ts/test/support.ts";
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
    // S13: the id a status hands out names its run (`diag-inv-1` alone is numbered per collection and repeats across runs)
    expect(diagnostic).toBe("run-e2:diag-inv-1");
    const explained = await json(["failure", diagnostic]);
    expect(explained.exitCode, explained.stdout).toBe(0);
    expect(explained.body.items[0]).toMatchObject({ id: "diag-inv-1", qualifiedId: "run-e2:diag-inv-1", runId: "run-e2", category: "assertion", exampleId: "watch.pending", selector: { examples: ["watch.pending"] }, basis: "stored-diagnostic" });
    expect(explained.body.items[0].nextAction).toContain("C");
    expect(qex.executions(), "two collections plus one catalogue refresh executed").toHaveLength(3);
  }, 180_000);

  // why: T4 / spec section 6 working loop on a FRESH repository, as skills/paneweft-views/SKILL.md tells it: the owner has registered the adapter and the
  // root (owner decisions) and nothing else. Discover (nothing catalogued yet), scaffold with an explicit source, implement (the repository changes and
  // now declares a new example), collect it, read the result. No `catalogue refresh` anywhere: the collection's own export resolves the new id and stores the
  // catalogue, after which discovery lists it.
  // proves: CLAIM(T4-run-exports) CLAIM(T4-fresh-repo) CLAIM(IV22-recipe)
  it("follows the skill on a fresh repository: list_types, scaffold, implement, collect, view_result, with no catalogue refresh", async () => {
    const qex = fake();
    const session = tmp("fresh-session");
    const root = tmp("fresh-root");
    cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
    makeRepo(root, {});
    const adapterFile = join(session, "..", `adapter-fresh-${Date.now()}.json`);
    writeFileSync(adapterFile, JSON.stringify(fakeCargoAdapter({ workspaceRoot: root })));
    const env = qex.env as Record<string, string>;
    const run = (args: string[]) => spawnPaneweft(["--session", session, ...args], { env });
    const json = async (args: string[]) => { const r = await run([...args, "--format", "json"]); return { ...r, body: r.stdout.trim() === "" ? null : JSON.parse(r.stdout) }; };
    const used: string[] = [];
    const step = async (args: string[]) => { used.push(args.slice(0, 2).join(" ")); return json(args); };

    expect((await run(["adapter", "add", "--file", adapterFile])).exitCode, "owner registers the adapter").toBe(0);
    expect((await run(["repo", "add", `vg=${root}`])).exitCode).toBe(0);

    const types = await step(["types", "--repo", "vg"]);
    expect(types.exitCode, types.stdout + types.stderr).toBe(0);
    expect(types.body).toMatchObject({ completeness: { status: "partial" }, freshness: { status: "unverified" }, counts: { total: 0 } });
    expect(types.body.notices.join(" ")).toMatch(/first collect/);

    const before = git(root, "status", "--porcelain");
    const scaffold = await step(["scaffold", "view", "--args", JSON.stringify({ repo: "vg", type: "vigil::watch::WatchFile", question: "What did the new example capture?", source: { path: "src/watch.rs", symbol: "WatchFile" } })]);
    expect(scaffold.exitCode, scaffold.stdout + scaffold.stderr).toBe(0);
    expect(git(root, "status", "--porcelain"), "scaffolding wrote nothing").toBe(before);

    // implement: the agent's edit. The repository now declares the example `watch.fresh`, and running it captures a shape view.
    writeFileSync(join(root, "src", "watch_fresh.rs"), "// the example and its view, implemented\n");
    const Watch = defineType<{ label: string }>({ id: "vigil::watch::WatchFile", source: { path: "src/watch.rs", symbol: "WatchFile" } });
    Watch.view({ id: "watch.fresh", title: "Fresh watch", question: "What did the new example capture?", priority: 1, component: "shape", render: (spec, view) => view.details().field("label", spec.label).done() });
    const capture = new Capture({ limits: specLimits() });
    capture.publish({ label: "pending" }, Watch);
    const graphFile = join(session, "..", `graph-fresh-${Date.now()}.json`);
    writeFileSync(graphFile, capture.finish().text);
    const catalogue = JSON.parse(readFileSync(join(FIXTURES, "v1/catalogues/watchfile.catalogue.json"), "utf8"));
    const base = catalogue.examples.find((example: any) => example.id === "watch.pending");
    const extraFile = join(session, "..", `extra-fresh-${Date.now()}.json`);
    writeFileSync(extraFile, JSON.stringify({ examples: [{ ...base, id: "watch.fresh", source: { path: "src/watch_fresh.rs", line: 1 }, selector: { ...base.selector, name: "tests::paneweft_example_watch_fresh" } }] }));
    qex.scenario({ catalogueExtra: extraFile, captureFile: graphFile });

    const started = await step(["collect", "--request-id", "f1", "--repo", "vg", "--adapter", "cargo", "--example", "watch.fresh"]);
    expect(started.exitCode, started.stdout + started.stderr).toBe(0);
    const done = await step(["collection", "status", "f1", "--wait-seconds", "30"]);
    expect(done.body.items[0], JSON.stringify(done.body)).toMatchObject({ state: "succeeded", runId: "run-f1", collectionStatus: "succeeded" });

    const result = await step(["result", "--run", "run-f1", "--view", "watch.fresh"]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.body)).toContain("pending");

    const after = await step(["examples", "--repo", "vg", "--type", "vigil::watch::WatchFile"]);
    expect(after.body.items.map((example: any) => example.id), "the collection's export stored the catalogue").toContain("watch.fresh");
    expect(after.body.freshness.status).toBe("fresh");
    expect(used.some((command) => command.startsWith("catalogue")), `no catalogue command in: ${used.join(", ")}`).toBe(false);
    expect(qex.executions(), "one catalogue export and one run").toHaveLength(2);
  }, 180_000);
});
