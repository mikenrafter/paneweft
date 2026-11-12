// @vitest-environment jsdom
// WHY CLAIM(S36): rejects mount's fallback-item lookup dropping a permitted entity that is absent from the fallback.
import { it, expect, vi } from "vitest";
import { goldenBundle, node, openBundle, useViewerCleanup, click } from "../../test/helpers/dom-harness.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
vi.mock("./renderer-host.ts", () => ({ renderRendererHost: ({ doc, openObject }: { doc: Document; openObject: (id: string) => void }) => {
  const button = doc.createElement("button"); button.dataset.pw = "permitted-object";
  button.addEventListener("click", () => openObject("o2")); return button;
} }));
const tmp = useTempDirs(); useViewerCleanup();
it("[S36] opens the permitted entity directly in its bound snapshot without a fallback item", async () => {
  const v = await openBundle(tmp("custom-nav"), goldenBundle("nav"), node("A"), "d-alt", { decorate: (source) => ({
    getEntity: (...args) => source.getEntity(...args), applicableViews: (...args) => source.applicableViews(...args),
    getView: (...args) => source.getView(...args), findExample: (...args) => source.findExample(...args),
    openItemSource: (...args) => source.openItemSource(...args), search: (...args) => source.search(...args), updateNotebook: (...args) => source.updateNotebook(...args),
    getViewFor: async (...args) => {
      const result = await source.getViewFor(...args);
      if (result.ok && args[0].id === "A") result.value.custom = { state: "ready", message: "", renderer: { id: "card", apiVersion: 1, assetDigest: "a".repeat(64) }, frame: { src: "/frame", frameId: "f", nonce: "n", payload: {}, objects: { o2: node("D") } } };
      return result;
    },
  }) });
  const snapshot = v.handle.state().trail[0]!.snapshotId;
  await click(v, v.container.querySelector('[data-pw="permitted-object"]')!);
  expect(v.handle.state().trail.map((p) => [p.entity.id, p.snapshotId])).toEqual([["A", snapshot], ["D", snapshot]]);
});
