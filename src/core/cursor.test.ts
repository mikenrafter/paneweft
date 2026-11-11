// why: review S10 changed the cursor wire form (compact, with a content digest). Literal vectors pin the form; the property pins decode(encode(x)) = x and
// that any single-character edit is rejected. The expected literal's checksum was computed outside this code base:
// printf '%s' 'paneweft-cursor/1:1.0123456789ab.89abcdef.3.0.-' | sha256sum | cut -c1-6  ->  8eda74.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeCursor, encodeCursor, queryDigest } from "./cursor.ts";

describe("cursor wire form", () => {
  it("encodes a position with a content digest to the documented literal", () => {
    expect(encodeCursor("0123456789ab", { index: 3, offset: 0 }, "89abcdef")).toBe("1.0123456789ab.89abcdef.3.0.-.8eda74");
    expect(encodeCursor("0123456789ab", { index: 7, offset: 25, format: "json" })).toMatch(/^1\.0123456789ab\.-\.7\.25\.j\.[0-9a-f]{6}$/);
  });

  it("decodes what it encodes, with and without content, text and json offsets", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[0-9a-f]{12}$/), fc.option(fc.stringMatching(/^[0-9a-f]{8}$/), { nil: undefined }), fc.nat(1_000_000), fc.nat(1_000_000), fc.constantFrom("text", "json" as const),
      (query, content, index, offset, format) => {
        const decoded = decodeCursor(encodeCursor(query, { index, offset, format: format as "text" | "json" }, content));
        return decoded.ok && decoded.query === query && decoded.content === content && decoded.position.index === index && decoded.position.offset === offset
          && decoded.position.format === (offset > 0 ? format : undefined);
      },
    ), { seed: 20260611, numRuns: 200 });
  });

  it("rejects every single-character change of a valid cursor and the usual garbage", () => {
    const valid = encodeCursor(queryDigest({ tool: "x" }), { index: 12, offset: 345, format: "text" }, "89abcdef");
    for (let at = 0; at < valid.length; at += 1) {
      const changed = valid.slice(0, at) + (valid[at] === "1" ? "2" : "1") + valid.slice(at + 1);
      expect(decodeCursor(changed).ok, `change at ${at}`).toBe(false);
    }
    for (const garbage of ["", "not-a-cursor", "!!!", "e30", `${valid}.`, valid.slice(0, 20)]) expect(decodeCursor(garbage).ok, garbage).toBe(false);
  });
});
