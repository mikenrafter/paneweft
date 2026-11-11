// Examples, invocation records, checks, composition and expected failures (spec section 3; amendments S6, N4).
//
// A failed check is recorded and the failure is kept until the body has returned its value, so the failing example still publishes
// the object it built (failed tests retain valid objects). `runExample` never throws: the failure is in the record and in `error`,
// and `exampleTest` rethrows `error` so the runner still fails.
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { limitsFromEnv, stagingFromEnv, writeArtifact, type Staging } from "./artifacts.ts";
import { Capture, runWithCapture, type TypeToken } from "./capture.ts";
import { callerLine } from "./callsite.ts";
import type { Json } from "./types.ts";

export type NativeOutcome =
  | { outcome: "passed" }
  | { outcome: "failed"; message: string }
  | { outcome: "error"; message: string }
  | { outcome: "blocked"; blockedBy: string }
  | { outcome: "skipped" | "cancelled" | "filtered" };

export interface CheckRecord {
  claim: string;
  passed: boolean;
}

export interface InvocationRecord {
  id: string;
  exampleId: string;
  attempt: number;
  parent: string | null;
  native: NativeOutcome;
  checks: CheckRecord[];
  /** passed AND at least one executed recorded check AND a captured result. A zero-check invocation is exploratory. */
  verified: boolean;
  expectedFailure?: { matched: boolean; diagnosticId: string | null };
  result: { captureId: string; object: string } | null;
}

export interface ExampleContext {
  /** Invokes the supplied native assertion callback and records whether it completed. Async callbacks must be awaited. */
  check(claim: string, assertion: () => void | Promise<void>): void | Promise<void>;
  /** Calls another example: fresh value each time, parent edge recorded, a failed child blocks this example. */
  use<T>(other: ExampleDefinition<T>): Promise<T>;
}

export interface ExampleSpec<T> {
  id: string;
  type: TypeToken<T>;
  claims: string[];
  kind?: "example" | "dead-end";
  run(cx: ExampleContext): T | Promise<T>;
}
export interface ExampleDefinition<T> extends ExampleSpec<T> {
  readonly typeId: string;
  /** The line of the call that defined the example (for the catalogue). */
  readonly definedAtLine?: number;
}

export function example<T>(spec: ExampleSpec<T>): ExampleDefinition<T> {
  const line = callerLine(0);
  return { ...spec, typeId: spec.type.id, ...(line === undefined ? {} : { definedAtLine: line }) };
}

/** A failed child, thrown into its parent by `cx.use`: the parent is `blocked`, not `failed`. */
class ChildFailed extends Error {
  constructor(readonly origin: string, readonly original: unknown) {
    super(`blocked by ${origin}`);
    this.name = "ChildFailed";
  }
}

/** A failure the SDK itself raises (an expectFailure that did not hold). */
class ExampleFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExampleFailure";
  }
}

interface Frame {
  id: string;
  exampleId: string;
  pending: { message: string; error: unknown } | undefined;
  checks: CheckRecord[];
  expectedFailure: { matched: boolean; diagnosticId: string; message: string } | undefined;
}

const PATH = new AsyncLocalStorage<Frame[]>();
const RECORDS: InvocationRecord[] = [];
let counter = 0;

const nextId = (): string => `inv-${process.pid}-${(counter += 1)}`;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const compact = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** The text a failure matcher reads: the message, plus the actual and expected values of an assertion error, because runners abbreviate
 * objects in the message ("{ a: 1, ...(2) }") and the field a dead end is about may be exactly the one that was elided. */
function failureText(error: unknown): string {
  const message = messageOf(error);
  if (typeof error === "object" && error !== null && "actual" in error && "expected" in error) {
    const { actual, expected } = error as { actual: unknown; expected: unknown };
    return `${message} (actual: ${compact(actual)}, expected: ${compact(expected)})`;
  }
  return message;
}

/** Drains the invocations recorded in this process, in start order. */
export function takeInvocations(): InvocationRecord[] {
  return RECORDS.splice(0, RECORDS.length);
}

function checkContext(frame: Frame): ExampleContext {
  const record = (claim: string, error: unknown, failed: boolean): void => {
    frame.checks.push({ claim, passed: !failed });
    if (failed && frame.pending === undefined) frame.pending = { message: messageOf(error), error };
  };
  return {
    check(claim, assertion) {
      try {
        const outcome = assertion();
        if (outcome !== undefined && typeof (outcome as Promise<void>).then === "function") {
          return (outcome as Promise<void>).then(() => record(claim, undefined, false), (error: unknown) => record(claim, error, true));
        }
        record(claim, undefined, false);
      } catch (error) {
        record(claim, error, true);
      }
      return undefined;
    },
    async use<T>(other: ExampleDefinition<T>): Promise<T> {
      const result = await runExample(other);
      if (result.failed) throw new ChildFailed(result.invocation.id, result.error);
      return result.value as T;
    },
  };
}

function nativeJson(native: NativeOutcome): Json {
  return native as unknown as Json;
}

interface CaptureSummary {
  outcome: "captured" | "failed" | "none";
  captureId?: string;
  diagnostics: string[];
  root?: string;
}

/** Runs an example: records the invocation, captures the result while it is borrowed, rethrows nothing. */
export type ExampleRun<T> =
  | { failed: false; value: T | undefined; invocation: InvocationRecord; error?: undefined }
  /** `error` is whatever was thrown, which may itself be `undefined`: `failed` is the discriminant, never `error !== undefined` (S18). */
  | { failed: true; value: T | undefined; invocation: InvocationRecord; error: unknown };

export async function runExample<T>(definition: ExampleDefinition<T>, options: { attempt?: number } = {}): Promise<ExampleRun<T>> {
  const staging: Staging | null = stagingFromEnv();
  const path = PATH.getStore() ?? [];
  const id = nextId();
  const startedAt = new Date().toISOString();
  const attempt = options.attempt ?? staging?.attempt ?? 1;
  const parent = path.length === 0 ? null : (path[path.length - 1] as Frame).id;
  const invocation: InvocationRecord = { id, exampleId: definition.id, attempt, parent, native: { outcome: "passed" }, checks: [], verified: false, result: null };
  RECORDS.push(invocation);
  const frame: Frame = { id, exampleId: definition.id, pending: undefined, checks: [], expectedFailure: undefined };
  const startedRecord = { id, exampleId: definition.id, attempt, parent, startedAt };
  if (staging !== null) writeArtifact(join(staging.dir, "invocations", `${id}.started.json`), startedRecord);

  if (path.some((entry) => entry.exampleId === definition.id)) {
    const message = `recursive example call: ${[...path.map((entry) => entry.exampleId), definition.id].join(" -> ")}`;
    invocation.native = { outcome: "error", message };
    if (staging !== null) writeArtifact(join(staging.dir, "invocations", `${id}.json`), completion(invocation, startedAt, { outcome: "none", diagnostics: [] }, undefined));
    return { failed: true, value: undefined, invocation, error: new Error(message) };
  }

  const capture = staging === null ? undefined : new Capture({ captureId: id, runId: staging.runId, invocationId: id, limits: limitsFromEnv() });
  let value: T | undefined;
  let thrown: unknown;
  let didThrow = false;
  const execute = (): Promise<T> => PATH.run([...path, frame], async () => definition.run(checkContext(frame)));
  try {
    value = await (capture === undefined ? execute() : runWithCapture(capture, execute));
  } catch (error) {
    didThrow = true;
    thrown = error;
  }

  let native: NativeOutcome;
  let error: unknown;
  let failed = true;
  if (didThrow && thrown instanceof ChildFailed) {
    native = { outcome: "blocked", blockedBy: thrown.origin };
    error = thrown;
  } else if (frame.pending !== undefined) {
    native = { outcome: "failed", message: frame.pending.message.slice(0, 2000) };
    error = frame.pending.error;
  } else if (didThrow) {
    native = thrown instanceof ExampleFailure ? { outcome: "failed", message: thrown.message.slice(0, 2000) } : { outcome: "error", message: messageOf(thrown).slice(0, 2000) };
    error = thrown;
  } else {
    native = { outcome: "passed" };
    failed = false;
  }

  const summary: CaptureSummary = { outcome: "none", diagnostics: [] };
  if (capture !== undefined && staging !== null) {
    if (frame.expectedFailure?.matched === true) capture.addDiagnostic("assertion", `expected failure reproduced: ${frame.expectedFailure.message}`, { exampleId: definition.id, id: frame.expectedFailure.diagnosticId });
    if (!didThrow) {
      const published = capture.publish(value, definition.type);
      if (published.status === "published" && "object" in published.ref) summary.root = published.ref.object;
    }
    summary.diagnostics = capture.diagnostics.map((d) => d.id);
    if (!didThrow || summary.diagnostics.length > 0) {
      summary.captureId = id;
      writeArtifact(join(staging.dir, "captures", `${id}.json`), capture.finish().toJSON());
    }
    summary.outcome = didThrow ? "none" : summary.root === undefined || capture.hasFault() ? "failed" : "captured";
  }

  invocation.native = native;
  invocation.checks = frame.checks;
  if (frame.expectedFailure !== undefined) invocation.expectedFailure = { matched: frame.expectedFailure.matched, diagnosticId: frame.expectedFailure.diagnosticId };
  invocation.verified = native.outcome === "passed" && frame.checks.length > 0 && frame.checks.every((check) => check.passed) && (staging === null || summary.outcome === "captured");
  if (summary.root !== undefined && summary.captureId !== undefined) invocation.result = { captureId: summary.captureId, object: summary.root };
  if (staging !== null) writeArtifact(join(staging.dir, "invocations", `${id}.json`), completion(invocation, startedAt, summary, frame));
  return failed ? { failed: true, value: didThrow ? undefined : value, invocation, error } : { failed: false, value, invocation };
}

function completion(invocation: InvocationRecord, startedAt: string, summary: CaptureSummary, frame: Frame | undefined): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: invocation.id,
    exampleId: invocation.exampleId,
    attempt: invocation.attempt,
    parent: invocation.parent,
    native: nativeJson(invocation.native),
    capture: { outcome: summary.outcome, ...(summary.captureId === undefined ? {} : { captureId: summary.captureId }), diagnostics: summary.diagnostics },
    checks: invocation.checks,
    verified: invocation.verified,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  if (invocation.result !== null) record.result = invocation.result;
  if (frame?.expectedFailure !== undefined) record.expectedFailure = { matched: frame.expectedFailure.matched, diagnosticId: frame.expectedFailure.diagnosticId };
  return record;
}

export type Matcher = { kind: "any" } | { kind: "message"; contains: string };
export const anyFailure: Matcher = { kind: "any" };
export function messageContains(text: string): Matcher {
  return { kind: "message", contains: text };
}

const describeMatcher = (matcher: Matcher): string => (matcher.kind === "any" ? "any failure" : `a failure containing ${JSON.stringify(matcher.contains)}`);

function failCurrent(message: string): never {
  const frames = PATH.getStore();
  const frame = frames === undefined ? undefined : frames[frames.length - 1];
  if (frame !== undefined && frame.pending === undefined) frame.pending = { message, error: new ExampleFailure(message) };
  throw new ExampleFailure(message);
}

function noteExpectedFailure(matched: boolean, message: string): string {
  const frames = PATH.getStore();
  const frame = frames === undefined ? undefined : frames[frames.length - 1];
  if (frame === undefined) return "diag-expected-failure";
  const diagnosticId = `diag-${frame.id}-expected-failure`;
  frame.expectedFailure = { matched, diagnosticId, message };
  return diagnosticId;
}

/** `expectFailure(matcher, fn)` (spec N4): a matched failure inside is captured, not propagated as "blocked by"; unexpected success
 * and unrelated errors fail the example. */
export async function expectFailure(matcher: Matcher, body: () => unknown | Promise<unknown>): Promise<{ message: string; diagnosticId: string }> {
  try {
    await body();
  } catch (caught) {
    const original = caught instanceof ChildFailed ? caught.original : caught;
    const message = failureText(original);
    if (matcher.kind === "any" || message.includes(matcher.contains)) return { message, diagnosticId: noteExpectedFailure(true, message) };
    noteExpectedFailure(false, message);
    return failCurrent(`expected ${describeMatcher(matcher)} but the body failed with: ${message}`);
  }
  noteExpectedFailure(false, "");
  return failCurrent(`unexpected success: expected ${describeMatcher(matcher)} but the body completed`);
}

