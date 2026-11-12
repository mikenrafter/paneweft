// WHY CLAIM(S34): rejects the SDK's unreachable custom-renderer path and proves a mandatory, bounded standard fallback.
import { it, expect } from "vitest";
import { Capture, defineType } from "./index.ts";
import { specLimits } from "../test/support.ts";
const renderer = { id: "card", apiVersion: 1, payloadSchemaDigest: "a".repeat(64), assetDigest: "b".repeat(64) };
it("[S34] emits a bounded custom view with its standard fallback through the SDK", () => {
  const T = defineType<{ label: string }>({ id: "test::Card", source: { path: "card.ts", symbol: "Card" } });
  T.view({ id: "card.view", title: "Card", question: "Which card?", priority: 1, component: "custom",
    render: (value, cx) => cx.custom(renderer, { label: value.label }, cx.details().field("label", value.label).done()) });
  const capture = new Capture({ limits: specLimits({ stringBytes: 2 }) });
  capture.publish({ label: "long" }, T);
  const graph = capture.finish().toJSON() as any;
  expect(graph.diagnostics).toEqual([]);
  expect(graph.views[0]).toMatchObject({ component: "custom", renderer, data: { renderer, fallback: { component: "shape" } } });
  expect(graph.views[0].data.fallback.data.fields[1].example).toBe("lo");
  expect(graph.views[0].completeness.status).toBe("partial");
  expect(JSON.stringify(graph).length).toBeLessThan(10000);
});
// WHY CLAIM(S34): an over-budget overlay must retain the already-built standard facts.
it("[S34] retains the standard fallback when the custom overlay has no room", () => {
  const T = defineType<object>({ id: "test::LargeCard", source: { path: "card.ts", symbol: "LargeCard" } });
  T.view({ id: "large.card", title: "Large card", question: "Which card?", priority: 1, component: "custom",
    render: (_value, cx) => cx.custom(renderer, { label: "x".repeat(100000) }, cx.details().field("label", "OK").done()) });
  const capture = new Capture({ limits: specLimits({ rootBytes: 4096, collectionBytes: 8192 }) });
  capture.publish({}, T);
  const graph = capture.finish(); const document = graph.toJSON() as any;
  expect(graph.emergency).toBe(false);
  expect(document.views[0]).toMatchObject({ component: "shape", completeness: { status: "partial" } });
  expect(document.views[0].data.fields[1].example).toBe("OK");
  expect(Buffer.byteLength(graph.text)).toBeLessThanOrEqual(8192);
});
