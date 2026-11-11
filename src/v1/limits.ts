// The capture bounds a collect request may ask for (S3). A request is untrusted: it can only LOWER a bound. Names and values are validated,
// and every value is clamped to the smaller of the SDK defaults (the spec's numbers) and the adapter's operator ceiling.
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";

export const LIMIT_NAMES = ["depth", "objects", "references", "rootBytes", "stringBytes", "pageRows", "collectionBytes", "roots", "viewRows", "viewBudgetMs"] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];

/** The SDK defaults (spec section 4): the highest any request can get. Same numbers as `defaultLimits()` and `Limits::default()`. */
export const SDK_LIMITS: Readonly<Record<LimitName, number>> = { depth: 4, objects: 1000, references: 4000, rootBytes: 2 * 1024 * 1024, stringBytes: 16 * 1024, pageRows: 100, collectionBytes: 32 * 1024 * 1024, roots: 100, viewRows: 10_000, viewBudgetMs: 100 };
/** The smallest value each bound can take (the object-graph schema's `minimum`). */
export const LIMIT_FLOORS: Readonly<Record<LimitName, number>> = { depth: 0, objects: 1, references: 0, rootBytes: 1, stringBytes: 1, pageRows: 1, collectionBytes: 1, roots: 1, viewRows: 1, viewBudgetMs: 1 };

/** The validated, clamped limits of a request, keys in a fixed order; `undefined` when none were requested. */
export function resolveRequestedLimits(requested: unknown, ceilings: Partial<Record<LimitName, number>> = {}): Result<Record<string, number> | undefined> {
  if (requested === undefined) return ok(undefined);
  if (requested === null || typeof requested !== "object" || Array.isArray(requested)) return err("INVALID_ARGUMENT", "limits must be an object of bound names to integers", { errors: [{ code: "TYPE", pointer: "/limits", constraint: "type: object", hint: `Use names from: ${LIMIT_NAMES.join(", ")}.` }] });
  const issues: ValidationIssue[] = [];
  const resolved: Record<string, number> = {};
  for (const name of Object.keys(requested).sort()) {
    const value = (requested as Record<string, unknown>)[name];
    if (!(LIMIT_NAMES as readonly string[]).includes(name)) {
      issues.push({ code: "UNKNOWN_PROPERTY", pointer: `/limits/${name}`, constraint: `one of ${LIMIT_NAMES.join(", ")}`, hint: "Remove the unknown bound." });
      continue;
    }
    const known = name as LimitName;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < LIMIT_FLOORS[known]) {
      issues.push({ code: "OUT_OF_RANGE", pointer: `/limits/${name}`, constraint: `an integer, at least ${LIMIT_FLOORS[known]}`, hint: "A bound is a whole number; a request can only lower it." });
      continue;
    }
    resolved[known] = Math.min(value, Math.max(LIMIT_FLOORS[known], Math.min(SDK_LIMITS[known], ceilings[known] ?? SDK_LIMITS[known])));
  }
  if (issues.length > 0) return err("INVALID_ARGUMENT", `the limits of the collect request are not acceptable (${issues.length} fault${issues.length === 1 ? "" : "s"})`, { errors: issues });
  return ok(resolved);
}
