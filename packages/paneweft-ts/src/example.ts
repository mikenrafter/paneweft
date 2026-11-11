// Examples, invocation records, checks, composition and expected failures (spec section 3; amendments S6, N4).
import type { TypeToken } from "./capture.ts";

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
}

export function example<T>(spec: ExampleSpec<T>): ExampleDefinition<T> {
  return { ...spec, typeId: spec.type.id };
}

/** Runs an example: records the invocation, captures the result while it is borrowed, rethrows failures. STUB: runs the body only. */
/** Never throws: a failure is in `invocation` and `error`. `exampleTest` rethrows `error` so the runner still fails. */
export async function runExample<T>(definition: ExampleDefinition<T>, options: { attempt?: number } = {}): Promise<{ value: T | undefined; invocation: InvocationRecord; error?: unknown }> {
  const invocation: InvocationRecord = { id: "", exampleId: definition.id, attempt: 1, parent: null, native: { outcome: "error", message: "NOT_IMPLEMENTED: runExample" }, checks: [], verified: false, result: null };
  return { value: undefined, invocation };
}

export type Matcher = { kind: "any" } | { kind: "message"; contains: string };
export const anyFailure: Matcher = { kind: "any" };
export function messageContains(text: string): Matcher {
  return { kind: "message", contains: text };
}

/** `expectFailure(matcher, fn)` (spec N4): a matched failure inside is captured, not propagated as "blocked by"; unexpected success
 * and unrelated errors fail the example. STUB: runs the body and returns an empty failure. */
export async function expectFailure(matcher: Matcher, body: () => unknown | Promise<unknown>): Promise<{ message: string; diagnosticId: string }> {
  return { message: "", diagnosticId: "" };
}

/** Drains the invocations recorded in this process, in start order. STUB: empty. */
export function takeInvocations(): InvocationRecord[] {
  return [];
}
