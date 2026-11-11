// @vitest-environment jsdom
// why: goldens are only meaningful if outline() is deterministic and sensitive to the things MC9 names:
// a deleted provenance badge and a reversed edge must change the outline (build-loop mutation list).
// scope: helper self-test, green by design in the red phase.
import { describe, expect, it } from "vitest";
import { outline } from "./structure.ts";

function build(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("outline helper", () => {
  const html = `<div data-pw="graph"><svg><g data-pw="graph-edge" data-id="e"><path data-pw="edge-path" d="M 1 2 L 3 4"></path></g></svg>
    <span data-pw="fact" data-id="a"><b data-pw="provenance-badge" data-provenance="read">read</b>  Label   one</span></div>`;

  it("lists data-pw elements with allowlisted attributes and collapsed own text", () => {
    expect(outline(build(html))).toBe(
      [
        "graph",
        "  graph-edge data-id=\"e\"",
        "    edge-path d=\"M 1 2 L 3 4\"",
        "  fact data-id=\"a\" \"Label one\"",
        "    provenance-badge data-provenance=\"read\" \"read\"",
        "",
      ].join("\n"),
    );
  });
  it("changes when a badge is deleted or an edge path is reversed (mutation sensitivity)", () => {
    const base = outline(build(html));
    expect(outline(build(html.replace(/<b data-pw="provenance-badge"[^>]*>read<\/b>/, "")))).not.toBe(base);
    expect(outline(build(html.replace("M 1 2 L 3 4", "M 3 4 L 1 2")))).not.toBe(base);
  });
  it("ignores non-contract markup and attributes", () => {
    expect(outline(build(html.replace("<svg>", '<svg class="x" style="fill:red">')))).toBe(outline(build(html)));
  });
});
