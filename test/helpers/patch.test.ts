// why: every negative test in this suite builds its invalid input with patch(); if patch() silently
// did nothing, those tests would pass vacuously (test-quality §6.3). This pins patch() itself.
// scope: helper self-test, green by design in the red phase.
import { describe, expect, it } from "vitest";
import { patch } from "./patch.ts";

describe("patch helper", () => {
  const base = { a: { b: [1, 2, 3] }, "x/y": 1 };
  it("replaces, adds, removes and does not mutate its input", () => {
    const out = patch(base, { op: "replace", path: "/a/b/1", value: 9 }, { op: "add", path: "/a/b/-", value: 4 }, { op: "remove", path: "/a/b/0" });
    expect(out.a.b).toEqual([9, 3, 4]);
    expect(base.a.b).toEqual([1, 2, 3]);
  });
  it("unescapes ~1 in pointers", () => {
    expect(patch(base, { op: "replace", path: "/x~1y", value: 2 })["x/y"]).toBe(2);
  });
  it("throws on a pointer that does not exist (negative control)", () => {
    expect(() => patch(base, { op: "replace", path: "/a/nope", value: 1 })).toThrow(/does not exist/);
    expect(() => patch(base, { op: "replace", path: "/a/b/7", value: 1 })).toThrow(/out of range/);
    expect(() => patch(base, { op: "remove", path: "/zzz/q" })).toThrow(/not found/);
  });
});
