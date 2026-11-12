// WHY CLAIM(S28): literal cross-language oracles reject numeric-key reordering and non-ECMAScript float encodings.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { canonicalJson } from "./canonical.ts";
import { sha256Hex } from "./digest.ts";
import { canonicalJson as sdkCanonical } from "../../packages/paneweft-ts/src/builders.ts";
const fixtures: Array<{name: string; source: string; canonical: string; sha256: string}> = JSON.parse(readFileSync(new URL("../../fixtures/v1/canonical-hashes.json", import.meta.url), "utf8"));
describe("[S28] literal JCS hashes shared with Rust", () => {
  it.each(fixtures)("$name", ({ source, canonical, sha256 }) => {
    for (const encode of [canonicalJson, sdkCanonical]) {
      expect(encode(JSON.parse(source))).toBe(canonical);
      expect(sha256Hex(encode(JSON.parse(source)))).toBe(sha256);
    }
  });
});
