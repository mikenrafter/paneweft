// Shared helpers of the SDK tests: fixture access, the language-neutral value and scenario interpreters, assertion-safe calls.
import { assert } from "vitest";
import { loadFixture, type Json } from "../../../test/helpers/fixtures.ts";
import { absent, defineType, redacted, type CapturedValue, type Limits, type TypeToken, Unsupported, defaultLimits } from "../src/index.ts";
import type { ViewBuilders } from "../src/index.ts";

export { loadFixture };
export type { Json };

/** Calls a stub-prone function and fails by assertion (not by a thrown stub error) when it throws. */
export function call<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (error) {
    assert.fail(`${what}: threw ${error instanceof Error ? error.message : String(error)}`);
  }
}
export async function callAsync<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    assert.fail(`${what}: threw ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The spec's limits with test overrides (the stub's default limits are zero, so tests state the numbers they rely on). */
export function specLimits(overrides: Json = null): Limits {
  const limits: Limits = { depth: 4, objects: 1000, references: 4000, rootBytes: 2 * 1024 * 1024, stringBytes: 16 * 1024, pageRows: 100, collectionBytes: 32 * 1024 * 1024, roots: 100, viewRows: 10_000, viewBudgetMs: 100 };
  if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) Object.assign(limits, overrides);
  return limits;
}
export const stubLimits = defaultLimits;

export function valueFromSpec(spec: any): CapturedValue {
  switch (spec.kind) {
    case "null": return null;
    case "bool": return spec.value;
    case "int": {
      const big = BigInt(spec.decimal);
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
    }
    case "float":
      if (spec.special === "NaN") return Number.NaN;
      if (spec.special === "Infinity") return Number.POSITIVE_INFINITY;
      if (spec.special === "-Infinity") return Number.NEGATIVE_INFINITY;
      if (spec.special === "-0") return -0;
      return spec.number;
    case "bytes": return new Uint8Array(Buffer.from(spec.base64, "base64"));
    case "absent": return absent;
    case "redacted": return redacted(spec.reason);
    case "unsupported": return new Unsupported(spec.reason);
    case "string": return spec.repeat ? spec.repeat.unit.repeat(spec.repeat.count) : spec.text;
    case "list": return spec.items.map(valueFromSpec);
    case "map": return new Map(spec.entries.map(([key, value]: [string, any]) => [key, valueFromSpec(value)]));
    default: throw new Error(`unknown value kind ${spec.kind}`);
  }
}

// ---- scenario nodes -------------------------------------------------------------------------------------------------------------

export interface TNode {
  typeId: string;
  key: string | null;
  label: string;
  fields: Array<[string, CapturedValue]>;
  links: Array<{ name: string; to: TNode }>;
}

const tokens = new Map<string, TypeToken<TNode>>();
export function tokenFor(typeId: string): TypeToken<TNode> {
  let token = tokens.get(typeId);
  if (token === undefined) {
    token = defineType<TNode>({ id: typeId, source: { path: "fixtures/v1/graphs", symbol: typeId } });
    token.view({
      id: "node.details",
      title: "Node",
      question: "What is this node?",
      priority: 10,
      component: "shape",
      render(node: TNode, view: ViewBuilders) {
        view.label(node.label);
        for (const [name, value] of node.fields) view.field(name, value);
        const details = view.details();
        details.field("label", node.label);
        for (const link of node.links) view.reference(link.to, tokenFor(link.to.typeId), { name: link.name, ...(link.to.key === null ? {} : { key: link.to.key }) });
        return details.done();
      },
    });
    tokens.set(typeId, token);
  }
  return token;
}

export function buildNodes(scenario: any): Map<string, TNode> {
  const nodes = new Map<string, TNode>();
  for (const [name, spec] of Object.entries<any>(scenario.nodes)) {
    nodes.set(name, { typeId: spec.type, key: spec.key, label: spec.label, fields: Object.entries<any>(spec.fields).map(([k, v]) => [k, valueFromSpec(v)]), links: [] });
  }
  for (const [name, spec] of Object.entries<any>(scenario.nodes)) {
    for (const link of spec.links) (nodes.get(name) as TNode).links.push({ name: link.name, to: nodes.get(link.to) as TNode });
  }
  return nodes;
}

export function expectedObjects(scenario: any): Json {
  return scenario.expected.objects.map((object: any) => {
    const { hashInput: _hashInput, ...rest } = object;
    return rest;
  });
}
