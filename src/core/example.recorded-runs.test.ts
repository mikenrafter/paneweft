// Review S8: a run recorded on an example view (example_record, `example run`) was stored but never shown: inspect, summaries and the viewer
// all read only the envelope's own `runs`, so an example that had been run still said "not run". The example view a user sees is now the
// envelope's runs PLUS the recorded runs, each with its provenance and its origin, assertions included.
// Derivation checked by hand: fixtures/components/all.bundle.json's example `vigil-one-write` has `runs: []`; passOutput("r1") records ONE passed run with
// ONE passing assertion (a1, provenance read, evidence s1), so after recording: 1 run, assertions 1/1, provenance read x2 (run + assertion), no "not run".
// Chain under test: a REAL runner process -> runExample -> inspect_view (text and json) -> HTTP /api/view -> the shipped bundle in JSDOM.
// proves: CLAIM(recorded-runs-visible)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeOperation } from "./operations.ts";
import { runExample } from "./runner.ts";
import { must } from "../../test/helpers/must.ts";
import { EXAMPLE_KEY, passOutput, runnerDefinition, writeRegistry } from "../../test/helpers/store-runner.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { useViewerDom } from "../../test/helpers/viewer-dom.ts";
import { bearer, jsonOf, rawRequest, useViewers } from "../../test/helpers/wire-http.ts";

const tmp = useTempDirs();
const viewers = useViewers();
const openPage = useViewerDom();
const KEY = { viewId: EXAMPLE_KEY.viewId, snapshotId: EXAMPLE_KEY.snapshotId };

async function recorded(runIds: string[]) {
  const session = await openOk(tmp("recorded-runs"));
  await importAll(session);
  for (const runId of runIds) must(await session.recordExampleRun(KEY, passOutput(runId)));
  return session;
}
const inspect = async (session: Awaited<ReturnType<typeof recorded>>, format: "text" | "json") => {
  const outcome = await executeOperation(session, "inspect_view", { ...KEY, format });
  expect(outcome.ok, outcome.body).toBe(true);
  return outcome.body;
};

describe("[S8] inspect shows the recorded runs of an example", () => {
  // control: an example nobody has run still says so.
  it("control: before any run the text reply says 'not run'", async () => {
    const session = await recorded([]);
    expect(await inspect(session, "text")).toContain("not run");
  });

  it("text: one recorded run is listed with its status, assertions and provenance, marked recorded, and 'not run' is gone", async () => {
    const body = await inspect(await recorded(["r1"]), "text");
    expect(body).toContain("r1: passed; assertions=1/1");
    expect(body).toMatch(/r1: passed; assertions=1\/1.*read; s1.*recorded/);
    expect(body).not.toContain("not run");
    expect(body).toContain("paneweft example run vigil-one-write");
  });

  it("json: counts, items and provenance include the recorded runs, each flagged with its origin", async () => {
    const reply = JSON.parse(await inspect(await recorded(["r1", "r2"]), "json"));
    expect(reply.counts).toMatchObject({ unit: "runs", total: 2, matched: 2, returned: 2 });
    expect(reply.items.map((item: { runId: string; origin: string }) => [item.runId, item.origin]).sort()).toEqual([["r1", "recorded"], ["r2", "recorded"]]);
    expect(reply.items[0].assertions).toHaveLength(1);
    expect(reply.provenance.read).toBe(1 + 4); // scenario (1) + two runs, each with one assertion (2 x 2); every item of the view is counted
    expect(reply).not.toHaveProperty("notRun");
  });
});

describe("[S8] the derived example view is valid even when recorded ids collide", () => {
  // why: every recorded run carries assertion id "a1"; the item ids of a view share one namespace, so merging them naively makes
  //      a view that fails its own schema rules. The derived view must keep every run and stay valid.
  it("two runs with the same assertion id appear as two runs with two assertions, ids made unique", async () => {
    const reply = JSON.parse(await inspect(await recorded(["first", "second"]), "json"));
    const ids = reply.items.flatMap((item: { id: string; assertions: Array<{ id: string }> }) => [item.id, ...item.assertions.map((assertion) => assertion.id)]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size, "ids unique across the view").toBe(4);
  });
});

describe("[S8] run -> inspect -> browser", () => {
  it("a runner started through runExample is listed by inspect and shown, with its assertion, by the shipped viewer", async () => {
    const base = tmp("recorded-run-chain");
    const workspace = join(base, "ws");
    mkdirSync(workspace);
    const { session, server } = await viewers.start({}, {}, join(base, "session"));
    const registry = writeRegistry(join(base, "registry"), [runnerDefinition("pass-runner.mjs", workspace)]);
    const run = must(await runExample(session, { runnerRegistryFile: registry, runnerId: "vigil-one-write", parameters: {}, key: KEY }));

    const text = (await executeOperation(session, "inspect_view", { ...KEY })).body;
    expect(text).toContain(`${run.runId}: passed`);
    expect(text).not.toContain("not run");

    const viewReply = await rawRequest(server, `/api/view?viewId=${KEY.viewId}&snapshotId=${KEY.snapshotId}`, { headers: bearer(server.token) });
    expect(jsonOf(viewReply).envelope.data.runs.map((item: { runId: string }) => item.runId)).toEqual([run.runId]);

    const page = openPage(server, KEY.viewId, KEY.snapshotId);
    await page.settled(() => expect(page.pw("run")).toHaveLength(1));
    const shown = page.pw("run")[0] as HTMLElement;
    expect([shown.getAttribute("data-run-id"), shown.getAttribute("data-status"), shown.getAttribute("data-origin")]).toEqual([run.runId, "passed", "recorded"]);
    expect(page.pw("assertion")).toHaveLength(1);
    expect(page.text(page.pw("assertion")[0])).toContain("PASS");
    expect(page.pw("not-run"), "an example with a recorded run is not 'not run'").toHaveLength(0);
  });
});
