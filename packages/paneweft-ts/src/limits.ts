import type { Limits } from "./types.ts";

/** The spec's numbers (section 4). `viewRows` bounds the rows of one view and defaults to v0's factItemsPerView because the spec gives
 * no per-view cap (docs/v1-red-contract.md section 5). */
export function defaultLimits(): Limits {
  return { depth: 4, objects: 1000, references: 4000, rootBytes: 2 * 1024 * 1024, stringBytes: 16 * 1024, pageRows: 100, collectionBytes: 32 * 1024 * 1024, roots: 100, viewRows: 10_000, viewBudgetMs: 100 };
}

/** The smallest value each bound can take (the object-graph schema's `minimum`). */
export const LIMIT_MINIMUMS: Readonly<Limits> = { depth: 0, objects: 1, references: 0, rootBytes: 1, stringBytes: 1, pageRows: 1, collectionBytes: 1, roots: 1, viewRows: 1, viewBudgetMs: 1 };

/** Overrides can only LOWER a bound (S3). A value is taken when it is a safe integer; it is raised to the schema minimum and then
 * clamped to the ceiling (default: the base, i.e. the operator's numbers), so a payload that asks for more than the operator allows gets
 * the operator's number, never its own. Unknown names, non-integers, negatives, strings and anything that is not an object are ignored. */
export function applyLimitOverrides(base: Limits, overrides: Partial<Limits> | undefined, ceiling: Limits = base): Limits {
  const limits = { ...base };
  if (overrides === undefined || overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) return limits;
  for (const key of Object.keys(limits) as Array<keyof Limits>) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
    limits[key] = Math.min(Math.max(LIMIT_MINIMUMS[key], value), Math.max(LIMIT_MINIMUMS[key], ceiling[key]), base[key]);
  }
  return limits;
}
