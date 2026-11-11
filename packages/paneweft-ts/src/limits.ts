import type { Limits } from "./types.ts";

/** STUB: all zero. Green returns depth 4, objects 1000, references 4000, rootBytes 2 MiB, stringBytes 16 KiB, pageRows 100,
 * collectionBytes 32 MiB, roots 100, viewRows 10_000 (v0 factItemsPerView), viewBudgetMs 100. */
export function defaultLimits(): Limits {
  return { depth: 0, objects: 0, references: 0, rootBytes: 0, stringBytes: 0, pageRows: 0, collectionBytes: 0, roots: 0, viewRows: 0, viewBudgetMs: 0 };
}
