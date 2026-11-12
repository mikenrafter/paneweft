// Which example produced a stored result and how that example ended (F24). A capture is published by one invocation; the invocation's own outcome and
// failed checks decide whether the value is the result of a passing example or what a failing one had built when it stopped. Pure over the run record;
// every string it returns came from captured data and is bounded here.
import type { SessionReader } from "../core/session.ts";
import type { NativeOutcome, TestRun } from "../generated/v1/TestRun.ts";
import { readJsonFile, runDirectory } from "./read.ts";
import { join } from "node:path";

export interface ExampleOfResult {
  runId: string;
  id: string;
  invocation: string;
  /** Called by another example's invocation (its own capture, not the selected example's). */
  nested: boolean;
  /** The outcome of the invocation that made the capture. */
  outcome: NativeOutcome;
  verified: boolean;
  /** The runner's message for a failed or errored invocation, bounded. */
  message?: string;
  failedClaims: Array<{ claim: string; message?: string; source?: { path: string; line: number } }>;
}

const MAX_CLAIMS = 10;
const MAX_TEXT = 300;
const bounded = (text: string): string => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}...`);

export function exampleOfCapture(run: TestRun, captureId: string): ExampleOfResult | undefined {
  const invocation = run.invocations.find((candidate) => candidate.capture.captureId === captureId);
  if (invocation === undefined) return undefined;
  const failed = invocation.checks.filter((check) => !check.passed);
  return {
    runId: run.runId, id: invocation.exampleId, invocation: invocation.id, nested: invocation.parent !== null, outcome: invocation.native.outcome, verified: invocation.verified,
    ...(invocation.native.message === undefined ? {} : { message: bounded(invocation.native.message) }),
    failedClaims: failed.slice(0, MAX_CLAIMS).map((check) => ({ claim: check.claim, ...(check.message === undefined ? {} : { message: bounded(check.message) }), ...(check.source === undefined ? {} : { source: check.source }) })),
  };
}

/** True when the value was captured by an example that did not pass, or that failed a claim. */
export const isFailedExample = (example: ExampleOfResult): boolean => example.outcome !== "passed" || example.failedClaims.length > 0;

/** The example of a stored view of a collected run, from the view's snapshot and entity id (`<capture>.<object>`); undefined for any other view. */
export async function exampleOfView(session: SessionReader, snapshotId: string, entityId: string): Promise<ExampleOfResult | undefined> {
  const dot = entityId.lastIndexOf(".");
  if (!snapshotId.startsWith("snap-") || snapshotId.length <= 5 || dot <= 0) return undefined;
  const runId = snapshotId.slice(5);
  const run = await readJsonFile<TestRun>(join(runDirectory(session, runId), "run.json")).catch(() => undefined);
  return run === undefined ? undefined : exampleOfCapture(run, entityId.slice(0, dot));
}
