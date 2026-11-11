// Cross-process flows (MC16, MC15, MC17): several REAL processes (spawned `paneweft` CLIs, a `paneweft mcp` server) share one
// session directory. Placement: cross-cutting by nature (it spans CLI, MCP, session store and viewer) and needs real processes,
// so no module owns it.
// All request bytes are the committed literals under fixtures/wire. Expected values are contract literals or follow from the
// committed fixtures (e.g. the page `wire-page` has two blocks b1, b2).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/core/session.ts";
import { startViewer } from "../src/viewer/server.ts";
import { spawnPaneweft, type CliRun } from "./helpers/cli.ts";
import { connectMcp } from "./helpers/mcp-client.ts";
import { must } from "./helpers/must.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { DIST_VIEWER } from "./helpers/wire-http.ts";
import { callTool } from "./helpers/wire-mcp.ts";
import { issuePairs, parseBody, runnerRegistryFor, seedClosed, seedSession, wireJson, wirePath } from "./helpers/wire-session.ts";

const makeTemp = useTempDirs();
const PAGE = "wire-page"; // the notebook envelope id in fixtures/wire/notebook-create.json (pageId = envelope id: WIRE-3)

const cli = (dir: string, words: string[], file?: string, extra: string[] = []): Promise<CliRun> =>
  spawnPaneweft(["--session", dir, ...words, ...(file === undefined ? [] : ["--args-file", wirePath(file)]), ...extra]);

async function reopen(dir: string) {
  return must(await openSession(dir), "reopen session");
}

describe("e2e: notebook across processes (MC16)", () => {
  // why: a page created by one CLI process must be readable by another process and over MCP, with identical bodies: the store, not
  //      process memory, is the source of truth (design 5 "CLI and stdio MCP processes call the same core"). The body facts are
  //      pinned independently: two blocks, counts in the `blocks` unit; the core confirms revision 1 and the block order b1, b2.
  // proves: CLAIM(MC16)
  it("[MC16] create with one CLI process, read with another CLI process and over MCP: identical bodies; the store holds revision 1", async () => {
    const dir = await seedClosed(makeTemp("e2e-nb"));
    const created = await cli(dir, ["notebook", "create"], "notebook-create.json");
    expect(created.exitCode, created.stdout.slice(0, 300)).toBe(0);
    const first = await cli(dir, ["notebook", "get"], "notebook-get.json");
    const second = await cli(dir, ["notebook", "get"], "notebook-get.json");
    const connection = await connectMcp(dir);
    let viaMcp;
    try {
      viaMcp = await callTool(connection, "notebook_get", wireJson("notebook-get.json"));
    } finally {
      await connection.close();
    }
    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.text).toBe(first.stdout);
    const body = parseBody(first.stdout, "stdout");
    expect(body.view.id).toBe(PAGE);
    expect(body.counts).toEqual({ unit: "blocks", total: 2, matched: 2, returned: 2, omitted: 0, truncated: false });
    expect(body.items.map((item: any) => item.id)).toEqual(["b1", "b2"]);

    const session = await reopen(dir);
    const page = must(await session.notebookGet(PAGE), "notebookGet");
    await session.close();
    expect(page.revision).toBe(1);
    expect(page.envelope.data).toEqual({ blocks: wireJson("notebook-create.json").input.data.blocks });
  });

  // why: the other direction: a page created through MCP is read by a CLI process with the same bytes the MCP read returns.
  // proves: CLAIM(MC16)
  it("[MC16] create over MCP, read with a CLI process: identical bodies", async () => {
    const dir = await seedClosed(makeTemp("e2e-nb-mcp"));
    const connection = await connectMcp(dir);
    let viaMcp;
    try {
      const created = await callTool(connection, "notebook_create", wireJson("notebook-create.json"));
      expect(created.isError, created.text.slice(0, 300)).toBe(false);
      viaMcp = await callTool(connection, "notebook_get", wireJson("notebook-get.json"));
    } finally {
      await connection.close();
    }
    const viaCli = await cli(dir, ["notebook", "get"], "notebook-get.json");
    expect(viaCli.exitCode).toBe(0);
    expect(viaCli.stdout).toBe(viaMcp.text);
  });

  // why: two writers from the same revision: exactly one wins (exit 0), the other gets CONFLICT with currentRevision 2 (exit 1)
  //      whatever the interleaving; the stored page is the winner's blocks at revision 2 and revision 1 is still readable
  //      (design 5, MC16 "Two updates from one revision yield one success and one conflict").
  // proves: CLAIM(MC16)
  it("[MC16] two concurrent `notebook update` processes from revision 1: one exit 0, one exit 1 with CONFLICT", async () => {
    const dir = await seedClosed(makeTemp("e2e-race2"));
    expect((await cli(dir, ["notebook", "create"], "notebook-create.json")).exitCode).toBe(0);
    const files = ["notebook-update-a.json", "notebook-update-b.json"];
    const runs = await Promise.all(files.map((file) => cli(dir, ["notebook", "update"], file)));
    expect(runs.map((run) => run.exitCode).sort(), runs.map((run) => run.stdout.slice(0, 200)).join(" | ")).toEqual([0, 1]);
    const loserIndex = runs.findIndex((run) => run.exitCode === 1);
    const winnerFile = files[1 - loserIndex]!;
    const conflict = parseBody(runs[loserIndex]!.stdout, "loser stdout");
    expect(conflict.code).toBe("CONFLICT");
    expect(conflict.details).toEqual({ currentRevision: 2 });

    const session = await reopen(dir);
    const latest = must(await session.notebookGet(PAGE), "latest");
    const original = must(await session.notebookGet(PAGE, 1), "revision 1");
    await session.close();
    expect(latest.revision).toBe(2);
    expect(latest.envelope.data).toEqual({ blocks: wireJson(winnerFile).blocks });
    expect(original.revision).toBe(1);
    expect(original.envelope.data).toEqual({ blocks: wireJson("notebook-create.json").input.data.blocks });
  });

  // why: the same with three writers: still exactly one success; every loser sees the same CONFLICT; one new revision only.
  // proves: CLAIM(MC16)
  it("[MC16] three concurrent updates from revision 1: one exit 0, two exit 1 CONFLICT, the store is at revision 2", async () => {
    const dir = await seedClosed(makeTemp("e2e-race3"));
    expect((await cli(dir, ["notebook", "create"], "notebook-create.json")).exitCode).toBe(0);
    const runs = await Promise.all(["a", "b", "c"].map((tag) => cli(dir, ["notebook", "update"], `notebook-update-${tag}.json`)));
    expect(runs.map((run) => run.exitCode).sort()).toEqual([0, 1, 1]);
    for (const loser of runs.filter((run) => run.exitCode === 1)) expect(parseBody(loser.stdout, "loser").code).toBe("CONFLICT");
    const session = await reopen(dir);
    expect(must(await session.notebookGet(PAGE), "latest").revision).toBe(2);
    await session.close();
  });

  // why: a stale write is reported identically to a CLI and to an MCP client (same CONFLICT body, same currentRevision).
  // proves: CLAIM(MC16), CLAIM(MC11)
  it("[MC16] a stale update after revision 2 is the same CONFLICT body over CLI and MCP", async () => {
    const dir = await seedClosed(makeTemp("e2e-stale"));
    expect((await cli(dir, ["notebook", "create"], "notebook-create.json")).exitCode).toBe(0);
    expect((await cli(dir, ["notebook", "update"], "notebook-update-a.json")).exitCode).toBe(0);
    const viaCli = await cli(dir, ["notebook", "update"], "notebook-update-b.json"); // still says expectedRevision 1
    const connection = await connectMcp(dir);
    let viaMcp;
    try {
      viaMcp = await callTool(connection, "notebook_update", wireJson("notebook-update-b.json"));
    } finally {
      await connection.close();
    }
    expect(viaCli.exitCode).toBe(1);
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toBe(viaCli.stdout);
    const body = parseBody(viaCli.stdout, "stdout");
    expect(body.code).toBe("CONFLICT");
    expect(body.details).toEqual({ currentRevision: 2 });
    expect(issuePairs(body)).toEqual([]); // a conflict has no field location (design 4: empty errors array)
  });
});

describe("e2e: a running viewer is discovered through server.json (MC15)", () => {
  // why: a CLI or MCP process finds the viewer of the session only via server.json: render must return the URL the viewer would hand
  //      out, with its token in the fragment, from a different process than the one running the server (red-contract 8).
  // proves: CLAIM(MC15)
  it("[MC15] CLI and MCP render return viewerUrl equal to urlFor(viewKey) of the viewer running in another process", async () => {
    const dir = makeTemp("e2e-viewer");
    const session = await seedSession(dir);
    const server = must(await startViewer({ session, assetsDirectory: DIST_VIEWER }), "startViewer");
    try {
      const expected = server.urlFor({ viewId: "modules", snapshotId: "snap-1" });
      const viaCli = await cli(dir, ["render"], "render-valid-json.json");
      expect(viaCli.exitCode, viaCli.stdout.slice(0, 300)).toBe(0);
      expect(parseBody(viaCli.stdout, "stdout").viewerUrl).toBe(expected);
      const connection = await connectMcp(dir);
      try {
        const viaMcp = await callTool(connection, "render", wireJson("render-valid-json.json"));
        expect(parseBody(viaMcp.text, "text").viewerUrl).toBe(expected);
      } finally {
        await connection.close();
      }
    } finally {
      await server.close();
      await session.close();
    }
    const after = await cli(dir, ["render"], "render-valid-json.json");
    expect(parseBody(after.stdout, "stdout").viewerUrl, "server.json is gone after close").toBeNull();
  });
});

describe("e2e: owner runners through the CLI (MC17)", () => {
  async function runnerSetup(timeoutMs?: number) {
    const dir = await seedClosed(makeTemp("e2e-run"));
    const workspace = makeTemp("e2e-run-ws");
    const registry = join(workspace, "runners.json");
    writeFileSync(registry, runnerRegistryFor({ workspace, ...(timeoutMs === undefined ? {} : { timeoutMs }) }));
    const run = (runnerId: string) =>
      cli(dir, ["example", "run", runnerId], undefined, ["--runners", registry, "--view", "vigil-one-write", "--snapshot", "snap-1"]);
    return { dir, workspace, registry, run };
  }

  // why: an owner-registered runner IS executed by `example run` (the canary marker proves a process ran), its run id comes from
  //      paneweft (PANEWEFT_RUN_ID, which the runner copies into the marker and the output), the result is recorded as a passed
  //      run, and running again records a second run with a DIFFERENT id (red-contract 10, MC17 "repeated runs with distinct run IDs").
  // proves: CLAIM(MC17)
  it("[MC17] `example run wire-runner` executes the owner's runner, records a passed run, and a rerun gets a distinct run id", async () => {
    const setup = await runnerSetup();
    const first = await setup.run("wire-runner");
    expect(first.exitCode, first.stdout.slice(0, 400)).toBe(0);
    const firstMarker = readFileSync(join(setup.workspace, "ran.marker"), "utf8");
    const second = await setup.run("wire-runner");
    expect(second.exitCode, second.stdout.slice(0, 400)).toBe(0);
    const secondMarker = readFileSync(join(setup.workspace, "ran.marker"), "utf8");
    expect(secondMarker).not.toBe(firstMarker);

    const session = await reopen(setup.dir);
    const runs = must(await session.listRuns({ viewId: "vigil-one-write", snapshotId: "snap-1" }), "listRuns");
    await session.close();
    expect(runs.map((run) => run.status)).toEqual(["passed", "passed"]);
    expect(runs.map((run) => run.runId).sort()).toEqual([firstMarker, secondMarker].sort());
  });

  // why: control for the refusal tests: with the same registry an unknown id is RUNNER_NOT_FOUND and the runner does NOT run
  //      (no marker), so "nothing ran" evidence elsewhere is meaningful (the marker appears when it does run, test above).
  // proves: CLAIM(MC17)
  it("[MC17] an unknown runner id with the same registry is RUNNER_NOT_FOUND and nothing runs", async () => {
    const setup = await runnerSetup();
    const missing = await setup.run("NOPE");
    expect(missing.exitCode).toBe(1);
    expect(parseBody(missing.stdout, "stdout").code).toBe("RUNNER_NOT_FOUND");
    expect(existsSync(join(setup.workspace, "ran.marker"))).toBe(false);
  });

  // why: a runner exceeding its timeout is killed and reported as RUNNER_TIMEOUT (exit 1), recording no run; the 500 ms timeout
  //      against a 60 s sleep is a process-level wait (the runner is `node -e` with a long timer), not a sleep in the test.
  // proves: CLAIM(MC17)
  it("[MC17] a runner that outlives timeoutMs is RUNNER_TIMEOUT and records no run", async () => {
    const dir = await seedClosed(makeTemp("e2e-timeout"));
    const workspace = makeTemp("e2e-timeout-ws");
    const registry = join(workspace, "runners.json");
    writeFileSync(
      registry,
      JSON.stringify({
        runners: [{ id: "sleeper", executable: process.execPath, argv: ["-e", "setTimeout(() => {}, 60000)"], workspaceRoot: workspace, parameterSchema: { type: "object", additionalProperties: false, properties: {} }, timeoutMs: 500, outputBundlePath: "out.json" }],
      }),
    );
    const run = await cli(dir, ["example", "run", "sleeper"], undefined, ["--runners", registry, "--view", "vigil-one-write", "--snapshot", "snap-1"]);
    expect(run.exitCode).toBe(1);
    expect(parseBody(run.stdout, "stdout").code).toBe("RUNNER_TIMEOUT");
    const session = await reopen(dir);
    expect(must(await session.listRuns({ viewId: "vigil-one-write", snapshotId: "snap-1" }), "listRuns")).toEqual([]);
    await session.close();
  });

  // why: output that is not a paneweft.run/1 document is RUNNER_OUTPUT_INVALID (exit 1) and records nothing (red-contract 10).
  // proves: CLAIM(MC17)
  it("[MC17] a runner that writes non-JSON output is RUNNER_OUTPUT_INVALID and records no run", async () => {
    const dir = await seedClosed(makeTemp("e2e-badout"));
    const workspace = makeTemp("e2e-badout-ws");
    const registry = join(workspace, "runners.json");
    writeFileSync(
      registry,
      JSON.stringify({
        runners: [{ id: "garbage", executable: process.execPath, argv: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(join(workspace, "out.json"))}, "not json")`], workspaceRoot: workspace, parameterSchema: { type: "object", additionalProperties: false, properties: {} }, timeoutMs: 20000, outputBundlePath: "out.json" }],
      }),
    );
    const run = await cli(dir, ["example", "run", "garbage"], undefined, ["--runners", registry, "--view", "vigil-one-write", "--snapshot", "snap-1"]);
    expect(run.exitCode).toBe(1);
    expect(parseBody(run.stdout, "stdout").code).toBe("RUNNER_OUTPUT_INVALID");
    const session = await reopen(dir);
    expect(must(await session.listRuns({ viewId: "vigil-one-write", snapshotId: "snap-1" }), "listRuns")).toEqual([]);
    await session.close();
  });
});
