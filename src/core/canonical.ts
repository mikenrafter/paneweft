// Canonical JSON: object keys sorted by code unit at every level, arrays keep their order, no whitespace.
// Reason: content hashes identify snapshots and stored views (design section 5: "canonicalize object keys and
//   unordered lookup tables; keep ordered arrays ordered"); two documents that differ only in key order must
//   hash alike, two that differ in content must not.
// Invariants: pure; `undefined` object members are dropped exactly like JSON.stringify does.
// CLAIM(own-keys): an own member named "__proto__" is kept, sorted and hashed like any other (it is built into a null-prototype object, where
//   assignment cannot set a prototype), and `ownValue` reads a dictionary without ever returning an inherited name such as "constructor"
//   [dictionary-keys.test.ts, review S5].
// Pure and browser-safe on purpose (the viewer bundle imports it); the sha256 digests live in digest.ts (node only).
// Mating parts: digest.ts (content hashes). Independent oracle: test/helpers/store-canon.ts.

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Code-unit string order, the single comparison used wherever "sorted" is promised. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The value of an OWN property of a caller-keyed dictionary, else undefined (never `constructor`, `toString`, ... from the prototype chain). */
export function ownValue<T>(dictionary: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}
