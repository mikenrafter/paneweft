// Tagged non-JSON values (spec decision 9, amendment S11) against the literal fixtures shared with the Rust SDK.
import { describe, expect, it } from "vitest";
import { absent, defaultLimits, displayValue, encodeValue, redacted } from "./index.ts";
import { call, loadFixture, specLimits, valueFromSpec } from "../test/support.ts";

const fixture = loadFixture<any>("v1/values.json");

describe("[S11] tagged values", () => {
  // why: both SDKs must encode the same value to the same tagged JSON. Required names are pinned so the loop cannot shrink silently.
  // proves: CLAIM(S11-tagged-values) CLAIM(IV9)
  it("every fixture case encodes to its literal JSON", () => {
    const names: string[] = fixture.cases.map((c: any) => c.name);
    for (const required of ["first-unsafe-int", "u64-max", "nan", "negative-zero", "bytes", "absent", "redacted-with-reason", "string-truncated-never-splits-a-code-point", "map-with-the-reserved-key-is-wrapped"]) expect(names).toContain(required);
    const failures: string[] = [];
    for (const item of fixture.cases) {
      const limits = specLimits(item.limits ?? fixture.limits);
      const actual = call(() => encodeValue(valueFromSpec(item.input), limits), item.name);
      if (JSON.stringify(actual) !== JSON.stringify(item.expected)) failures.push(`${item.name}: expected ${JSON.stringify(item.expected)} got ${JSON.stringify(actual)}`);
    }
    expect(failures, `${failures.length} of ${fixture.cases.length} cases differ`).toEqual([]);
  });

  // why: a JavaScript number beyond the safe range is ALREADY lossy; the SDK must refuse to guess (spec decision 9: reject lossy
  // numeric conversion) instead of tagging a possibly wrong integer as exact. Proposed default, see the report (A7).
  // proves: CLAIM(S11-tagged-values)
  it("an unsafe integer-valued JS number is an unsupported lossy-number, a bigint is exact", () => {
    const limits = specLimits();
    expect(encodeValue(2 ** 53, limits)).toEqual({ $paneweft: "unsupported", reason: "lossy-number" });
    expect(encodeValue(9007199254740993n, limits)).toEqual({ $paneweft: "bigint", decimal: "9007199254740993" });
    expect(encodeValue(42n, limits)).toBe(42);
  });

  // why: JS absence (`undefined`) and a null are different states and must not collapse (spec: distinct tagged states).
  // proves: CLAIM(S11-tagged-values)
  it("undefined and the absent marker are the absent tag; null stays null", () => {
    const limits = specLimits();
    expect(encodeValue(undefined, limits)).toEqual({ $paneweft: "absent" });
    expect(encodeValue(absent, limits)).toEqual({ $paneweft: "absent" });
    expect(encodeValue(null, limits)).toBeNull();
    expect(encodeValue(redacted(), limits)).toEqual({ $paneweft: "redacted" });
  });

  // why: arbitrary JavaScript getters are never evaluated by default (spec section 4); a record with a getter must not run it.
  // proves: CLAIM(S11-tagged-values)
  it("a getter is not evaluated and a function is unsupported", () => {
    let evaluated = 0;
    const record = Object.defineProperty({ plain: 1 }, "computed", { enumerable: true, get() { evaluated += 1; return 2; } });
    const encoded = encodeValue(record as never, specLimits()) as Record<string, unknown>;
    expect(encoded, "an object encoding").not.toBeNull();
    expect(evaluated).toBe(0);
    expect(encoded.plain).toBe(1);
    expect(encoded.computed).toEqual({ $paneweft: "unsupported", reason: "getter" });
    expect(encodeValue((() => 1) as never, specLimits())).toEqual({ $paneweft: "unsupported", reason: "function" });
  });

  // why: the same display table as the Rust test (hand-written in the fixture).
  // proves: CLAIM(S11-tagged-values) CLAIM(S12-text-completeness)
  it("display formats tagged values for cells and shape examples", () => {
    expect(fixture.display.cases).toHaveLength(9);
    for (const item of fixture.display.cases) expect(call(() => displayValue(valueFromSpec(item.input)), item.text)).toBe(item.text);
  });

  // why: defaults are the spec's numbers; v0 factItemsPerView bounds rows per view (spec gives no per-view cap).
  // proves: CLAIM(IV9)
  it("default limits are the spec numbers", () => {
    expect(defaultLimits()).toEqual({ depth: 4, objects: 1000, references: 4000, rootBytes: 2 * 1024 * 1024, stringBytes: 16 * 1024, pageRows: 100, collectionBytes: 32 * 1024 * 1024, roots: 100, viewRows: 10_000, viewBudgetMs: 100 });
  });
});
