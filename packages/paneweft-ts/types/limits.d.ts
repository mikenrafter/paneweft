import type { Limits } from "./types.js";
/** The spec's numbers (section 4). `viewRows` bounds the rows of one view and defaults to v0's factItemsPerView because the spec gives
 * no per-view cap (docs/v1-red-contract.md section 5). */
export declare function defaultLimits(): Limits;
/** The smallest value each bound can take (the object-graph schema's `minimum`). */
export declare const LIMIT_MINIMUMS: Readonly<Limits>;
/** Overrides can only LOWER a bound (S3). A value is taken when it is a safe integer; it is raised to the schema minimum and then
 * clamped to the ceiling (default: the base, i.e. the operator's numbers), so a payload that asks for more than the operator allows gets
 * the operator's number, never its own. Unknown names, non-integers, negatives, strings and anything that is not an object are ignored. */
export declare function applyLimitOverrides(base: Limits, overrides: Partial<Limits> | undefined, ceiling?: Limits): Limits;
