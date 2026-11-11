// Assertion helpers for the validation suites (tag: val).
// They fail by assertion, never by a thrown stub error, and they compare the WHOLE issue list so that
// "some error" can never pass for "the right error" (red-contract section 2: one fault, one issue).
import { assert, expect } from "vitest";
import type { ValidationReport } from "../../src/core/validate.ts";

export interface Expected {
  code: string;
  pointer: string;
}

export type RejectedReport = Extract<ValidationReport, { ok: false }>;

/** The report must be a rejection whose issues are exactly `expected`, already in (pointer, code) order. */
export function expectRejected(report: ValidationReport, expected: readonly Expected[], kind?: "envelope" | "bundle" | "unknown") {
  if (report.ok) assert.fail(`expected rejection ${JSON.stringify(expected)} but the input was accepted (kind ${report.kind})`);
  expect(report.errors.map((issue) => ({ code: issue.code, pointer: issue.pointer }))).toEqual([...expected]);
  for (const issue of report.errors) {
    // red-contract section 2: constraint states the rule, hint is never empty.
    expect(issue.constraint, `constraint of ${issue.code} ${issue.pointer}`).toMatch(/\S/);
    expect(issue.hint, `hint of ${issue.code} ${issue.pointer}`).toMatch(/\S/);
  }
  if (kind !== undefined) expect(report.kind).toBe(kind);
  return report.errors;
}

/** The report must be an acceptance of the given kind. */
export function expectAccepted(report: ValidationReport, kind: "envelope" | "bundle") {
  if (!report.ok) assert.fail(`expected acceptance but got ${JSON.stringify(report.errors)}`);
  expect(report.kind).toBe(kind);
}

/** The report must be an acceptance of any kind (run outputs have no kind of their own in ValidationReport). */
export function expectOk(report: ValidationReport) {
  if (!report.ok) assert.fail(`expected acceptance but got ${JSON.stringify(report.errors)}`);
}

/** Token assertions on the single issue of a one-issue rejection. */
export function expectTokens(report: ValidationReport, tokens: { constraint?: string[]; hint?: string[] }) {
  if (report.ok) assert.fail("expected a rejection");
  expect(report.errors).toHaveLength(1);
  const issue = report.errors[0]!;
  for (const token of tokens.constraint ?? []) expect(issue.constraint).toContain(token);
  for (const token of tokens.hint ?? []) expect(issue.hint).toContain(token);
}

/** Wraps a call that must not throw (a thrown error would be a crash, reported as a plain assertion failure). */
export function calm<T>(call: () => T, what: string): T {
  try {
    return call();
  } catch (error) {
    return assert.fail(`${what} threw instead of returning a report: ${String(error)}`);
  }
}
