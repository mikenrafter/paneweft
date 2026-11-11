// v0 limits (design section 4, "v0 accepts at most ...").
// CLAIM(limits): these numbers are the design's [docs/design.md section 4; limits.test.ts].
export const LIMITS = {
  viewBytes: 2 * 1024 * 1024,
  bundleBytes: 8 * 1024 * 1024,
  factItemsPerView: 10_000,
  graphNodes: 200,
  graphEdges: 500,
  nestingLevels: 32,
  stringBytes: 64 * 1024,
  embedDepth: 1,
} as const;

export const BUDGET = { defaultBytes: 8192, minimumBytes: 2048, maximumBytes: 32768 } as const;
