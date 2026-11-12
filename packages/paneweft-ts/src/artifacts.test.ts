// The artifact protocol in TypeScript (docs/v1-red-contract.md section 7): same environment, same files as the Rust SDK.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV, defineType, example, runExample, stagingFromEnv, takeInvocations } from "./index.ts";
import { callAsync } from "../test/support.ts";

const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); for (const name of Object.values(ENV)) delete process.env[name]; });

const Subject = defineType<{ tick: number }>({ id: "fixture::Subject", source: { path: "x.ts", symbol: "Subject" } });
Subject.view({ id: "subject.details", title: "Subject", question: "Which tick?", priority: 10, component: "shape", render: (s, view) => view.details().field("tick", s.tick).done() });
const pending = example({ id: "subject.pending", type: Subject, claims: ["S1"], run(cx) { cx.check("S1", () => {}); return { tick: 0 }; } });

describe("[IV8] artifact protocol", () => {
  // why: the collector hands the worker its identity through the environment; without the collect flag the SDK is silent.
  // proves: CLAIM(IV8)
  it("reads staging from the environment and is absent without the collect flag", () => {
    expect(stagingFromEnv({})).toBeNull();
    expect(stagingFromEnv({ PANEWEFT_COLLECT: "0", PANEWEFT_RUN_ID: "r", PANEWEFT_STAGING_DIR: "/x" })).toBeNull();
    expect(stagingFromEnv({ PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-abc", PANEWEFT_STAGING_DIR: "/tmp/paneweft-staging-x", PANEWEFT_ATTEMPT: "3" })).toEqual({ runId: "run-abc", dir: "/tmp/paneweft-staging-x", attempt: 3 });
  });

  // why: IV8/IV5. A collected invocation leaves a completion record with the REAL run id, attempt and checks, plus its capture, in the
  // staging directory the collector chose and nowhere else. The record has the same fields the Rust SDK writes.
  // proves: CLAIM(IV8) CLAIM(IV5) CLAIM(IV6)
  it("a collected example writes its invocation and capture artifacts", async () => {
    takeInvocations();
    const dir = mkdtempSync(join(tmpdir(), "paneweft-ts-"));
    created.push(dir);
    Object.assign(process.env, { PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-x", PANEWEFT_STAGING_DIR: dir, PANEWEFT_ATTEMPT: "2" });
    await callAsync(() => runExample(pending), "runExample");
    expect(existsSync(join(dir, "invocations")), "the invocations directory exists").toBe(true);
    const completions = readdirSync(join(dir, "invocations")).filter((name) => !name.endsWith(".started.json"));
    expect(completions).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(dir, "invocations", completions[0] as string), "utf8"));
    expect(record).toMatchObject({ exampleId: "subject.pending", attempt: 2, parent: null, native: { outcome: "passed" }, checks: [{ claim: "S1", passed: true }], verified: true, capture: { outcome: "captured" } });
    expect(typeof record.finishedAt).toBe("string");
    const graph = JSON.parse(readFileSync(join(dir, "captures", `${record.capture.captureId}.json`), "utf8"));
    expect(graph).toMatchObject({ schemaVersion: "paneweft.object-graph/1", runId: "run-x" });
    expect(graph.objects[0].typeId).toBe("fixture::Subject");
    expect(readdirSync(dir).sort()).toEqual(["captures", "invocations"]);
  });

  // why: a worker that aborts leaves a started record and no completion record (spec section 3); the started record must exist while
  // the body runs.
  // proves: CLAIM(IV17)
  it("a started record exists while the body runs and the completion record does not", async () => {
    takeInvocations();
    const dir = mkdtempSync(join(tmpdir(), "paneweft-ts-"));
    created.push(dir);
    mkdirSync(dir, { recursive: true });
    Object.assign(process.env, { PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-y", PANEWEFT_STAGING_DIR: dir });
    let seen: string[] = [];
    const observing = example({ id: "subject.observing", type: Subject, claims: ["O"], run(cx) { seen = existsSync(join(dir, "invocations")) ? readdirSync(join(dir, "invocations")) : []; cx.check("O", () => {}); return { tick: 1 }; } });
    await callAsync(() => runExample(observing), "runExample");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\.started\.json$/);
  });
});
