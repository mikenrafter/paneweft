// Review round 2, S12 [adapter-parity]: `navigate` looked its item up in the STORED envelope (viewsOfEntity) while `inspect_view` reads the EFFECTIVE view
// (readEffectiveView: the envelope's runs plus the runs recorded on it). So after `example record` an agent could inspect a run, take its id from the reply
// and navigate to its result - and be told the item does not exist. The effective envelope must be what every adapter navigates in.
// Chain per adapter: record a run (in-process session) -> inspect_view (the run is listed) -> navigate to that run item -> the run's result entity opens.
// Adapters: the core operation, the CLI (a real process) and MCP (a real stdio server); one session directory, and the three bodies must agree byte for byte.
// World: fixtures/components/all.bundle.json (example `vigil-one-write` of entity vigil/watch "watch", definition def-example, no runs) and
// passOutput("r1"): one passed run `run-r1` whose result is entity json/value "result-r1" (registered in snap-1 by the run's bundle).
// proves: CLAIM(recorded-runs-visible) CLAIM(MC11)
import { describe, expect, it } from "vitest";
import { executeOperation } from "../src/core/operations.ts";
import { spawnPaneweft } from "./helpers/cli.ts";
import { connectMcp } from "./helpers/mcp-client.ts";
import { must } from "./helpers/must.ts";
import { EXAMPLE_KEY, passOutput } from "./helpers/store-runner.ts";
import { importAll, openOk } from "./helpers/store-session.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tmp = useTempDirs();
const PANE = { entity: { repository: "r", id: "watch", kind: "vigil/watch" }, snapshotId: "snap-1", viewDefinitionId: "def-example" };
const RESULT = { repository: "r", id: "result-r1", kind: "json/value" };

async function sessionWithRecordedRun(output = passOutput("r1")): Promise<string> {
  const dir = tmp("navigate-effective");
  const session = await openOk(dir);
  await importAll(session);
  must(await session.recordExampleRun(EXAMPLE_KEY, output));
  return dir;
}

interface Answer { exitCode: number; body: string }
/** The same request through the three adapters. */
async function throughAdapters(dir: string, tool: "inspect_view" | "navigate", args: Record<string, unknown>): Promise<{ core: Answer; cli: Answer; mcp: Answer }> {
  const session = await openOk(dir);
  const outcome = await executeOperation(session, tool, args);
  const cli = await spawnPaneweft(["--session", dir, tool === "navigate" ? "navigate" : "inspect", "--args", JSON.stringify(args)]);
  const connection = await connectMcp(dir);
  try {
    const mcp = await connection.call(tool, args);
    return { core: { exitCode: outcome.ok ? 0 : 1, body: outcome.body }, cli: { exitCode: cli.exitCode, body: cli.stdout }, mcp: { exitCode: mcp.isError ? 1 : 0, body: mcp.text } };
  } finally {
    await connection.close();
  }
}

describe("[S12] navigate resolves items in the same effective view as inspect", () => {
  // why: the item id comes from inspect's own reply, so navigate must accept every id inspect printed.
  it("record -> inspect -> navigate to the recorded run's result opens the result entity, identically through core, CLI and MCP", async () => {
    const dir = await sessionWithRecordedRun();
    const inspected = await throughAdapters(dir, "inspect_view", { ...EXAMPLE_KEY, format: "json" });
    expect(inspected.cli.body, "CLI and MCP print what the core prints").toBe(inspected.core.body);
    expect(inspected.mcp.body).toBe(inspected.core.body);
    const items = JSON.parse(inspected.core.body).items as Array<{ id: string; runId: string; origin: string }>;
    const run = items.find((item) => item.runId === "r1");
    expect(run, "inspect lists the recorded run").toMatchObject({ origin: "recorded" });

    const navigated = await throughAdapters(dir, "navigate", { pane: PANE, itemId: (run as { id: string }).id, format: "json" });
    for (const [adapter, answer] of Object.entries(navigated)) {
      expect(answer.exitCode, `${adapter}: ${answer.body}`).toBe(0);
      const reply = JSON.parse(answer.body);
      expect(reply.pane, adapter).toMatchObject({ entity: RESULT, snapshotId: "snap-1" });
    }
    expect(navigated.cli.body, "CLI and core agree byte for byte").toBe(navigated.core.body);
    expect(navigated.mcp.body, "MCP and core agree byte for byte").toBe(navigated.core.body);
  }, 60_000);

  // why: the same lookup serves assertions of a recorded run; one that has no target answers the NO_TARGET notice, not "does not exist".
  it("an assertion of the recorded run is found too: it has no entity, so the answer is the NO_TARGET notice in every adapter", async () => {
    const dir = await sessionWithRecordedRun();
    const navigated = await throughAdapters(dir, "navigate", { pane: PANE, itemId: "a1", format: "json" });
    for (const [adapter, answer] of Object.entries(navigated)) {
      expect(answer.exitCode, `${adapter}: ${answer.body}`).toBe(0);
      expect(JSON.parse(answer.body), adapter).toMatchObject({ pane: null, notice: { code: "NO_TARGET", itemId: "a1" } });
    }
    expect(navigated.cli.body).toBe(navigated.core.body);
    expect(navigated.mcp.body).toBe(navigated.core.body);
  }, 60_000);

  // why: the source action resolves the same item; "no such item" would be wrong for an item inspect lists. The view records tests/mcp_e2e.rs (its source s1) and no
  //      stored source view covers it, so the honest answer for an anchored recorded assertion is that no stored excerpt covers the anchor.
  it("open-source on an anchored assertion of the recorded run finds the assertion, and says that no stored excerpt covers its anchor, in every adapter", async () => {
    const output = passOutput("r1");
    output.run.assertions[0].anchor = { repository: "r", path: "tests/mcp_e2e.rs", lines: [1, 2] };
    const dir = await sessionWithRecordedRun(output);
    const navigated = await throughAdapters(dir, "navigate", { pane: PANE, itemId: "a1", action: "open-source", format: "json" });
    for (const [adapter, answer] of Object.entries(navigated)) {
      expect(answer.exitCode, adapter).toBe(1);
      const error = JSON.parse(answer.body);
      expect(error, adapter).toMatchObject({ code: "UNRESOLVED_TARGET" });
      expect(error.message, adapter).toContain("no stored source excerpt");
      expect(error.message, adapter).not.toContain("does not exist");
    }
    expect(navigated.cli.body).toBe(navigated.core.body);
    expect(navigated.mcp.body).toBe(navigated.core.body);
  }, 60_000);

  // control: an item of the stored envelope navigates as before, and an id nobody lists is still unresolved, so the lookup is live and not "accept anything".
  it("control: the stored scenario is found (NO_TARGET) and an unknown id is UNRESOLVED_TARGET, through the core", async () => {
    const session = await openOk(await sessionWithRecordedRun());
    const scenario = await executeOperation(session, "navigate", { pane: PANE, itemId: "once", format: "json" });
    expect(scenario.ok, scenario.body).toBe(true);
    expect(JSON.parse(scenario.body)).toMatchObject({ pane: null, notice: { code: "NO_TARGET", itemId: "once" } });
    const unknown = await executeOperation(session, "navigate", { pane: PANE, itemId: "no-such-item", format: "json" });
    expect(unknown.ok).toBe(false);
    expect(JSON.parse(unknown.body)).toMatchObject({ code: "UNRESOLVED_TARGET" });
  });
});
