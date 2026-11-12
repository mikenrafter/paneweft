// Builders for collections the field test made and the single-example fixtures cannot: several examples in one run (object ids restart in every
// capture, so `o1` names one object per example), failed examples, runs that captured nothing, and runs the host recorded at chosen times.
import { collectionFixture, type CollectionFixture } from "./v1-world.ts";
import type { CollectionImport } from "../../src/v1/import.ts";

export interface ExampleSpec {
  id: string;
  outcome?: "passed" | "failed" | "error" | "cancelled";
  /** false: the example captured nothing (a cancelled or crashed example); no object graph is imported for it. */
  capture?: boolean;
  checks?: Array<{ claim: string; passed: boolean; message?: string }>;
  /** Nested invocations: example ids this example's invocation called; each gets its own capture, as the SDK does. */
  calls?: string[];
}

/** An import of `runId` holding one capture per example, all built from the vigil-redelivered graph: every capture has an `o1` (the watch file
 * with its `watch.status` and `watch.events` views) and the events `o2..o4`. */
export function multiExampleImport(runId: string, examples: ExampleSpec[], base: CollectionFixture = collectionFixture("vigil-redelivered")): CollectionImport {
  const graphText = JSON.stringify(base.graphs[0]);
  const run = JSON.parse(JSON.stringify(base.run));
  run.runId = runId;
  run.examples = [];
  run.invocations = [];
  const graphs: unknown[] = [];
  let n = 0;
  const counts = { selected: examples.length, passed: 0, failed: 0, error: 0, skipped: 0, filtered: 0, cancelled: 0, blocked: 0, verified: 0, exploratory: 0 };
  const invoke = (spec: { id: string; outcome?: ExampleSpec["outcome"]; capture?: boolean; checks?: ExampleSpec["checks"] }, parent: string | null): string => {
    n += 1;
    const invocationId = `inv-${n}`;
    const outcome = spec.outcome ?? "passed";
    const captured = spec.capture !== false;
    const checks = spec.checks ?? (outcome === "cancelled" ? [] : [{ claim: `C${n}`, passed: outcome === "passed" }]);
    if (captured) graphs.push(JSON.parse(graphText.replaceAll("inv-1", invocationId).replaceAll("run-1", runId)));
    run.invocations.push({
      id: invocationId, exampleId: spec.id, attempt: 1, parent, native: { outcome, ...(outcome === "failed" ? { message: checks.find((check) => !check.passed)?.message ?? "a check failed" } : {}) },
      capture: captured ? { outcome: "captured", captureId: invocationId, diagnostics: [] } : { outcome: "none", diagnostics: [] },
      checks, verified: outcome === "passed" && checks.length > 0 && captured,
      ...(captured ? { result: { captureId: invocationId, object: "o1" } } : {}),
      startedAt: "2026-11-11T12:00:00Z", finishedAt: "2026-11-11T12:00:01Z",
    });
    return invocationId;
  };
  for (const spec of examples) {
    const outcome = spec.outcome ?? "passed";
    const id = invoke(spec, null);
    for (const called of spec.calls ?? []) invoke({ id: called }, id);
    run.examples.push({ id: spec.id, attempts: [id], final: id, outcome, verified: outcome === "passed" && spec.capture !== false, priorFailures: [], suiteFailedAfter: [] });
    counts[outcome] += 1;
    if (outcome === "passed" && spec.capture !== false) counts.verified += 1;
  }
  run.collection = { ...run.collection, status: examples.every((example) => (example.outcome ?? "passed") === "passed") ? "succeeded" : examples.some((example) => example.outcome === "cancelled") ? "cancelled" : "failed", cancelled: examples.some((example) => example.outcome === "cancelled"), counts };
  return { repo: "vg", runId, jobId: null, origin: "host_collected", run, graphs };
}
