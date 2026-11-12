// @vitest-environment jsdom
// why: F24. The viewer showed the half-built value of a failed example exactly like a verified observation. The status strip of a view whose model
//   carries a failing example says so, names the example and the failed claims, and does it as text (what a captured message holds is data).
// proves: CLAIM(F24-failed-example) viewer marks it.
import { describe, expect, it } from "vitest";
import { SUBJECT, goldenBundle, openBundle, paneAt, qa, text, fixedFresh, useViewerCleanup } from "../../test/helpers/dom-harness.ts";
import type { ViewerSource } from "./source.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

const withExample = (example: Record<string, unknown>) => (source: ViewerSource): ViewerSource => {
  const decorated = fixedFresh(source);
  const patch = <T extends { ok: boolean; value?: any }>(result: T): T => (result.ok ? { ...result, value: { ...result.value, example } } : result);
  return { ...decorated, getViewFor: async (...args) => patch(await decorated.getViewFor(...args)), getView: async (...args) => patch(await decorated.getView(...args)) };
};

describe("[F24] the viewer marks a result of a failed example", () => {
  it("shows the example, the outcome and each failed claim in the status strip", async () => {
    const v = await openBundle(tmp("f24"), goldenBundle("shape"), SUBJECT, "d-shape", { decorate: withExample({ runId: "run-cmf-1", id: "mapping.broken", invocation: "inv-1", nested: false, outcome: "failed", verified: false, failedClaims: [{ claim: "CMX", message: "expected <b>'Work'</b> to be 'Personal'" }] }) });
    const marks = qa(paneAt(v, 0), "example-outcome");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute("data-outcome")).toBe("failed");
    expect(text(marks[0])).toContain("mapping.broken");
    expect(text(marks[0])).toContain("failed");
    expect(text(marks[0])).toContain("CMX");
    expect(text(marks[0])).toContain("expected <b>'Work'</b> to be 'Personal'");
    expect(marks[0]!.querySelector("b"), "a captured message is text, never markup").toBeNull();
  });

  it("shows nothing extra for an example that passed", async () => {
    const v = await openBundle(tmp("f24-pass"), goldenBundle("shape"), SUBJECT, "d-shape", { decorate: withExample({ runId: "run-1", id: "mapping.parsed", invocation: "inv-1", nested: false, outcome: "passed", verified: true, failedClaims: [] }) });
    expect(qa(paneAt(v, 0), "example-outcome")).toHaveLength(0);
  });
});
