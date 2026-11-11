// Validation = limits, then JSON Schema (Ajv 2020-12, strict), then semantic checks.
// One core used by CLI, MCP, session import and viewer (design section 5).
//
// Reason: agent-submitted documents are the trust boundary; nothing reaches storage or the
// browser without passing here.
// Errors: never throws; every fault is a ValidationIssue sorted by (pointer, code).
// Invariants: deterministic for equal input; a single fault yields a single issue.
// Mating parts: tools/validate (MCP), `paneweft validate` (CLI), Session.importBundle.
import type { EntityRef } from "./wire.ts";
import type { ValidationIssue } from "./errors.ts";

/** What lies outside the submitted document, so cross references can be checked against it. */
export interface ReferenceContext {
  views?: Array<{ id: string; snapshotId: string; itemIds: string[] }>;
  entities?: Array<EntityRef & { snapshotId: string }>;
  definitionIds?: string[];
}

export interface ValidationNote { pointer: string; message: string }

export type ValidationReport =
  | { ok: true; kind: "envelope" | "bundle"; notes: ValidationNote[] }
  | { ok: false; kind: "envelope" | "bundle" | "unknown"; errors: ValidationIssue[] };

/** STUB. */
export function validateSubmission(_input: unknown, _context?: ReferenceContext): ValidationReport {
  return {
    ok: false,
    kind: "unknown",
    errors: [{ code: "CONSTRAINT", pointer: "", constraint: "stub", hint: "validateSubmission is not implemented" }],
  };
}

/** Validates a `paneweft.run/1` document (runner output / example_record input). STUB. */
export function validateRunOutput(_input: unknown, _context?: ReferenceContext): ValidationReport {
  return {
    ok: false,
    kind: "unknown",
    errors: [{ code: "CONSTRAINT", pointer: "", constraint: "stub", hint: "validateRunOutput is not implemented" }],
  };
}
