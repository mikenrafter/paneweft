// why: dogfooding notes #9 and #12 for the text and JSON replies. The shape reply printed `path: type (presence)` but never the field's `label`; the graph reply
//   printed `from -relation-> to` and never the edge's `label`, which carries the call chain or payload. Both must be in the text, whole (no clipping: the text
//   form is where the full value lives), and the JSON items already hold them.
import { describe, expect, it } from "vitest";
import { okJson, okText, useOps } from "../../test/helpers/ops-env.ts";
import { bundleOf, complete, edge, graphView, node, shapeField, shapeView } from "../../test/helpers/ops-views.ts";

const open = useOps();
const ARGS = (viewId: string) => ({ viewId, snapshotId: "snap-1" });
const LONG = "Hotswap first; standard claim: tabs.get -> activateStandard -> StandardHandler.activate -> parseBookmarkUrl";

describe("[#12] graph text edge list carries the edge label", () => {
  const view = () => graphView({ id: "flow", definitionId: "def-flow", nodes: [node("a"), node("b")], edges: [edge("e1", "a", "b", "launch", { label: LONG }), edge("e2", "b", "a", "reply")], paths: null, completeness: complete("two edges") });
  it("[#12] the labelled edge line ends with | label=\"...\" in full; the unlabelled one is unchanged", async () => {
    const env = await open(bundleOf([view()]));
    const body = okText(await env.call("inspect_view", ARGS("flow"))).raw;
    expect(body).toContain(`a -launch-> b; read; s1 | label=${JSON.stringify(LONG)}\n`);
    expect(body).toContain("b -reply-> a; read; s1\n");
  });
  it("[#12] JSON keeps the label on the edge item", async () => {
    const env = await open(bundleOf([view()]));
    const reply = okJson(await env.call("inspect_view", { ...ARGS("flow"), format: "json" }));
    expect(reply.items.find((item: { id: string }) => item.id === "e1").label).toBe(LONG);
  });
});

describe("[#9] shape text carries the field label", () => {
  const view = () => shapeView({ id: "rec", definitionId: "def-rec", root: "f1", fields: [shapeField("f1", "token", "string", { label: "Authentication token", example: "abc" }), shapeField("f2", "count", "number")], completeness: complete("two fields") });
  it("[#9] a labelled field line ends with | label=\"...\"; the unlabelled one is unchanged; the path stays", async () => {
    const env = await open(bundleOf([view()]));
    const body = okText(await env.call("inspect_view", ARGS("rec"))).raw;
    expect(body).toContain('token: string (required); read; s1; example: "abc" | label="Authentication token"\n');
    expect(body).toContain("count: number (required); read; s1; no example\n");
  });
});
