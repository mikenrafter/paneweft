// Object identity, cycles, shared children, domain keys and bounds (IV9) against the literal graphs shared with the Rust SDK.
import { describe, expect, it } from "vitest";
import { Capture } from "./index.ts";
import { buildNodes, call, expectedObjects, loadFixture, specLimits, tokenFor } from "../test/support.ts";

const SCENARIOS = ["shared-child", "cycle", "self-cycle", "duplicate-domain-keys", "depth-limit", "object-limit", "reference-limit", "separate-observations", "identity-token"];

function run(scenario: any): any {
  const nodes = buildNodes(scenario);
  const capture = new Capture({ limits: specLimits(scenario.limits ?? null) });
  for (const publish of scenario.publish) {
    const entry = typeof publish === "string" ? { node: publish, identity: undefined } : publish;
    const node = nodes.get(entry.node)!;
    const outcome = capture.publish(node, tokenFor(node.typeId), entry.identity === undefined ? {} : { identity: entry.identity });
    expect(outcome.status, `${scenario.name}: publish ${entry.node}`).toBe("published");
  }
  return capture.finish().toJSON();
}

describe("[IV9] object graphs", () => {
  // why: the scenario list must not shrink silently (test-quality: iterating over the current set).
  // proves: CLAIM(IV9)
  it("the pinned scenario files exist", () => {
    for (const name of SCENARIOS) expect(() => loadFixture(`v1/graphs/${name}.json`)).not.toThrow();
  });

  for (const name of SCENARIOS) {
    // why: each scenario file states its own WHY; the expected graph was written by hand (hashes via sha256sum of hashInput).
    // proves: CLAIM(IV9) CLAIM(S11-alias)
    it(`scenario ${name}`, () => {
      const scenario = loadFixture<any>(`v1/graphs/${name}.json`);
      const graph = call(() => run(scenario), name);
      expect(graph.roots, `${name}: roots`).toEqual(scenario.expected.roots);
      expect(graph.objects, `${name}: ${scenario.why}`).toEqual(expectedObjects(scenario));
      expect(graph.completeness?.status, `${name}: completeness status`).toBe(scenario.expected.completeness.status);
      expect(graph.completeness?.omitted, `${name}: named omissions`).toEqual(scenario.expected.completeness.omitted);
    });
  }

  // why: wire ids are opaque capture-scoped identifiers (spec section 4): the ids of a fresh capture of the same graph are identical
  // run to run, in registration order.
  // proves: CLAIM(IV9)
  it("object ids are deterministic registration order, not identities of allocations", () => {
    const scenario = loadFixture<any>("v1/graphs/shared-child.json");
    const first = call(() => run(scenario), "first");
    const second = call(() => run(scenario), "second");
    expect(first.objects).toEqual(second.objects);
    expect(first.objects.map((o: any) => o.id)).toEqual(["o1", "o2", "o3", "o4"]);
  });

  // why: IV21: equal domain keys with different contents hash differently; nothing collapses by display label.
  // proves: CLAIM(IV9) CLAIM(IV21)
  it("content hashes distinguish redelivered duplicates", () => {
    const graph = call(() => run(loadFixture("v1/graphs/duplicate-domain-keys.json")), "run");
    expect(graph.objects[1].domainKey).toBe(graph.objects[2].domainKey);
    expect(graph.objects[1].contentHash).not.toBe(graph.objects[2].contentHash);
  });
});
