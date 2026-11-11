// Independent canonical-JSON oracle (design section 5: "canonicalize object keys ... keep ordered
// arrays ordered"). Canonical text = JSON.stringify with object keys sorted by code unit, recursively,
// no whitespace; hash = sha256 of its UTF-8 bytes. Defined here, not imported from src/.
import { sha256Hex } from "./hash.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null); // not {}: assigning "__proto__" to {} sets the prototype (review S5)
    for (const key of Object.keys(value as object).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
/** Same value, every object's keys in REVERSE insertion order; arrays keep their order. */
export function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).reverse()) out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}
