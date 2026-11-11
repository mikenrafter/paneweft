// Canonical JSON: object keys sorted by code unit at every level, arrays keep their order, no whitespace.
// Reason: content hashes identify snapshots and stored views (design section 5: "canonicalize object keys and
//   unordered lookup tables; keep ordered arrays ordered"); two documents that differ only in key order must
//   hash alike, two that differ in content must not.
// Invariants: pure; `undefined` object members are dropped exactly like JSON.stringify does.
// Mating parts: Session (content hashes), RecordedRun.contentHash. Independent oracle: test/helpers/store-canon.ts.
import { createHash } from "node:crypto";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Code-unit string order, the single comparison used wherever "sorted" is promised. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
