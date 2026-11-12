// @vitest-environment jsdom
// why: F19. In the viewer, Enter on a row whose target the capture did not keep did nothing and showed nothing; spec section 4: "A missing target yields a
//   bounded missing-capture explanation". The row says it is not captured and why, and Enter shows the explanation as an alert.
// proves: CLAIM(F19-not-captured) viewer part.
import { describe, expect, it } from "vitest";
import { byId, fixedFresh, focusEl, goldenBundle, need, node, openBundle, paneAt, panes, press, text, useViewerCleanup, q } from "../../test/helpers/dom-harness.ts";
import type { ViewerSource } from "./source.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

/** The model of every view with the row `a-none` marked as a target the capture did not keep. */
const notCapturedRow = (source: ViewerSource): ViewerSource => {
  const decorated = fixedFresh(source);
  const patch = <T extends { ok: boolean; value?: any }>(result: T): T => {
    if (!result.ok || result.value.envelope.component !== "list") return result;
    const rows = result.value.envelope.data.rows.map((row: any) => (row.id === "a-none" ? { ...row, notCaptured: { reason: "object-limit" } } : row));
    return { ...result, value: { ...result.value, envelope: { ...result.value.envelope, data: { ...result.value.envelope.data, rows } } } };
  };
  return { ...decorated, getViewFor: async (...args) => patch(await decorated.getViewFor(...args)), getView: async (...args) => patch(await decorated.getView(...args)) };
};

describe("[F19] the viewer explains a target that was not captured", () => {
  it("shows the reason on the row and an alert on Enter, and opens no pane", async () => {
    const v = await openBundle(tmp("f19"), goldenBundle("nav"), node("A"), "d-children", { decorate: notCapturedRow });
    const row = byId(paneAt(v, 0), "row", "a-none");
    expect(text(need(row, "no-target"))).toContain("not captured: object-limit");
    focusEl(row);
    await press(v, "Enter");
    expect(panes(v)).toHaveLength(1);
    const alert = q(v.container, "error");
    expect(alert, "an explanation is shown").not.toBeNull();
    expect(alert!.getAttribute("data-code")).toBe("NOT_CAPTURED");
    expect(text(alert)).toContain("a-none");
    expect(text(alert)).toContain("object-limit");
  });

  it("a plain row without a target keeps saying so and shows no alert", async () => {
    const v = await openBundle(tmp("f19-plain"), goldenBundle("nav"), node("A"), "d-children", { decorate: fixedFresh });
    const row = byId(paneAt(v, 0), "row", "a-none");
    expect(text(need(row, "no-target"))).not.toContain("not captured");
    focusEl(row);
    await press(v, "Enter");
    expect(q(v.container, "error")).toBeNull();
  });
});
