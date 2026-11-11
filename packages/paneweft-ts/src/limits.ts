import type { Limits } from "./types.ts";

/** The spec's numbers (section 4). `viewRows` bounds the rows of one view and defaults to v0's factItemsPerView because the spec gives
 * no per-view cap (docs/v1-red-contract.md section 5). */
export function defaultLimits(): Limits {
  return { depth: 4, objects: 1000, references: 4000, rootBytes: 2 * 1024 * 1024, stringBytes: 16 * 1024, pageRows: 100, collectionBytes: 32 * 1024 * 1024, roots: 100, viewRows: 10_000, viewBudgetMs: 100 };
}

/** Owner overrides can only lower a bound to a positive integer; anything else is ignored. */
export function applyLimitOverrides(base: Limits, overrides: Partial<Limits> | undefined): Limits {
  const limits = { ...base };
  if (overrides === undefined) return limits;
  for (const key of Object.keys(limits) as Array<keyof Limits>) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) limits[key] = key === "depth" || key === "references" ? value : Math.max(1, value);
  }
  return limits;
}
