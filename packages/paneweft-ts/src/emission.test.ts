// D1 (consolidation): every byte a capture emits passes one bounded serializer, so the emitted size is a property of that one path, not of
// the care taken in each helper. The properties below hold for ANY input; the fuzz cases are seeded, so a failure names its seed.
//
// What is measured is the document the SDK writes: the bytes of JSON.stringify of the whole graph (escaping included, page bodies
// included). `collectionBytes` bounds that document; `rootBytes` bounds the objects, views and stored pages of one root.
import { describe, expect, it } from "vitest";
import { Capture, defineType, type CapturedValue, type Limits, type TypeToken, redacted, Unsupported } from "./index.ts";
import { validateObjectGraph } from "../../../src/v1/capture.ts";
import { specLimits } from "../test/support.ts";

const bytes = (json: unknown): number => Buffer.byteLength(JSON.stringify(json), "utf8");

interface Spec {
  label: string;
  fields: Array<[string, CapturedValue]>;
  detail: Array<[string, CapturedValue]>;
  children: Array<{ name: string; key?: string; spec: Spec }>;
  columns: Array<{ key: string; title: string }>;
  rows: Array<{ id: string; cells: Record<string, CapturedValue> }>;
}

const Node: TypeToken<Spec> = defineType<Spec>({ id: "t::Node", source: { path: "emission.test.ts", symbol: "Node" } });
Node.view({
  id: "node.details", title: "Node", question: "What is this node?", priority: 1, component: "shape",
  render: (spec, view) => {
    view.label(spec.label);
    for (const [name, value] of spec.fields) view.field(name, value);
    const details = view.details();
    for (const [name, value] of spec.detail) details.field(name, value);
    for (const child of spec.children) view.reference(child.spec, Node, { name: child.name, ...(child.key === undefined ? {} : { key: child.key }) });
    return details.done();
  },
});
Node.view({
  id: "node.rows", title: "Rows", question: "Which rows?", priority: 2, component: "list",
  render: (spec, view) => {
    if (spec.columns.length === 0) return view.unsupported("no columns");
    const table = view.table();
    for (const column of spec.columns) table.textColumn(column.key, column.title);
    for (const row of spec.rows) table.row(row);
    return table.done();
  },
});

const empty = (): Spec => ({ label: "n", fields: [], detail: [], children: [], columns: [], rows: [] });

/** Set by `publish`: whether the final measure had to replace the document (a defect: the ledger and the measure disagree). */
let emergency = false;
function publish(roots: Spec[], limits: Partial<Limits>): any {
  const capture = new Capture({ limits: specLimits(limits) });
  for (const root of roots) capture.publish(root, Node);
  const graph = capture.finish();
  emergency = graph.emergency;
  return JSON.parse(graph.text);
}

/** The bytes of one root's records: its objects, its views and its stored pages (the ids of the objects between this root and the next). */
function rootSpans(graph: any): number[] {
  const index = (id: string): number => Number(id.slice(1));
  const starts: number[] = graph.roots.map(index);
  return starts.map((start, at) => {
    const end = at + 1 < starts.length ? (starts[at + 1] as number) : Infinity;
    const mine = (id: string): boolean => index(id) >= start && index(id) < end;
    // the records of a list and the commas between them; the brackets of the list belong to the frame of the document
    const records = (items: unknown[]): number => bytes(items) - 2;
    return records(graph.objects.filter((o: any) => mine(o.id))) + records(graph.views.filter((v: any) => mine(v.objectId))) + records(graph.pages.filter((p: any) => mine(p.objectId)));
  });
}

// ---- seeded adversarial generation ---------------------------------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
const between = (rng: Rng, low: number, high: number): number => low + Math.floor(rng() * (high - low + 1));

// units that JSON escapes (NUL, quote, backslash, newline, a lone surrogate), that take 2, 3 and 4 UTF-8 bytes, and plain ASCII
const UNITS = ["a", "b", "0", " ", "\u0000", "\u0001", "\"", "\\", "\n", "\u007f", "é", "€", " ", "😀", "\ud800", "…", "$paneweft", "__proto__"];

/** A name or a string: mostly short, sometimes a thousand characters or more. `huge` allows strings of tens of thousands (values, not keys: a wide
 * map of huge keys is megabytes of text that the unbounded reference run has to hold twice). */
function text(rng: Rng, shortest = 0, longest = 40, huge = true): string {
  const roll = rng();
  const length = roll < 0.03 ? between(rng, 1000, 3000) : huge && roll < 0.05 ? between(rng, 20_000, 60_000) : between(rng, shortest, longest);
  const heavy = pick(rng, UNITS);
  let out = "";
  while (out.length < length) out += rng() < 0.6 ? heavy : pick(rng, UNITS);
  return out;
}

/** A capture holds at most this many generated values, so the unbounded reference run of the property stays a few megabytes. */
const NODES = { left: 0 };

function value(rng: Rng, depth: number): CapturedValue {
  const roll = rng();
  NODES.left -= 1;
  if (depth >= 5 || roll < 0.35 || NODES.left <= 0) {
    switch (between(rng, 0, 9)) {
      case 0: return null;
      case 1: return rng() < 0.5;
      case 2: return between(rng, -1000, 1000);
      case 3: return BigInt(between(rng, 0, 1000)) ** 9n;
      case 4: return new Uint8Array(between(rng, 0, 20_000)).fill(7);
      case 5: return redacted(text(rng));
      case 6: return new Unsupported(text(rng));
      case 7: return undefined;
      default: return text(rng);
    }
  }
  const width = Math.min(NODES.left, rng() < 0.05 ? between(rng, 3000, 20_000) : between(rng, 0, 12));
  if (roll < 0.65) return Array.from({ length: width }, () => value(rng, depth + 1));
  if (roll < 0.82) return new Map<string, CapturedValue>(Array.from({ length: width }, () => [text(rng, 0, 20, false), value(rng, depth + 1)] as [string, CapturedValue]));
  const record: Record<string, CapturedValue> = {};
  for (let i = 0; i < width; i += 1) Object.defineProperty(record, text(rng, 0, 20, false), { value: value(rng, depth + 1), enumerable: true, configurable: true, writable: true });
  return record;
}

function spec(rng: Rng, depth: number): Spec {
  const node = empty();
  node.label = text(rng);
  node.fields = Array.from({ length: between(rng, 0, 6) }, () => [text(rng, 0, 30, false), value(rng, 0)] as [string, CapturedValue]);
  const seen = new Set<string>();
  for (let i = 0; i < between(rng, 0, 5); i += 1) {
    const name = `${text(rng, 1, 30).slice(0, 100)}#${i}`;
    if (!seen.has(name)) { seen.add(name); node.detail.push([name, value(rng, 2)]); }
  }
  if (depth < 4) node.children = Array.from({ length: between(rng, 0, 3) }, () => ({ name: text(rng, 1, 30), ...(rng() < 0.5 ? { key: text(rng) } : {}), spec: spec(rng, depth + 1) }));
  if (rng() < 0.7) {
    node.columns = Array.from({ length: between(rng, 1, 3) }, (_, at) => ({ key: `${text(rng, 1, 20).slice(0, 100)}@${at}`, title: text(rng, 1, 30).slice(0, 200) }));
    const rows = rng() < 0.1 ? between(rng, 300, 1200) : between(rng, 0, 40);
    node.rows = Array.from({ length: rows }, (_, at) => {
      const cells: Record<string, CapturedValue> = {};
      for (const column of node.columns) cells[column.key] = rng() < 0.7 ? text(rng, 0, 40, false) : between(rng, 0, 99);
      return { id: `${text(rng, 0, 20, false).slice(0, 90)}~${at}`, cells };
    });
  }
  return node;
}

function limitsFor(rng: Rng): Partial<Limits> {
  return {
    collectionBytes: between(rng, 4096, 70_000),
    rootBytes: rng() < 0.4 ? between(rng, 1500, 40_000) : 2 * 1024 * 1024,
    stringBytes: pick(rng, [64, 512, 4096, 16 * 1024]),
    pageRows: pick(rng, [1, 3, 10, 100]),
  };
}

describe("[D1] the emitted size is bounded by one serializer", () => {
  // why: D1 / S2 (round 3). A field name of 1,500 NUL characters passed a check of its raw length (1,500 < 4,096) and was then charged as the
  // JSON text it becomes (6 bytes per NUL): 9,617 bytes under collectionBytes=4,096. Rejects every implementation that decides
  // "fits" from a length of the input instead of the bytes of the output.
  // proves: CLAIM(D1-emitted-bytes)
  it.each([
    ["a field name", (nul: string): Spec => ({ ...empty(), fields: [[nul, 1]] })],
    ["a Map key", (nul: string): Spec => ({ ...empty(), fields: [["m", new Map([[nul, 1]])]] })],
    ["an object key", (nul: string): Spec => ({ ...empty(), fields: [["o", { [nul]: 1 }]] })],
    ["a detail name", (nul: string): Spec => ({ ...empty(), detail: [[nul.slice(0, 120), 1]] })],
    ["an edge name", (nul: string): Spec => ({ ...empty(), children: [{ name: nul, spec: empty() }] })],
    ["a domain key", (nul: string): Spec => ({ ...empty(), children: [{ name: "c", key: nul, spec: empty() }] })],
    ["a label", (nul: string): Spec => ({ ...empty(), label: nul })],
    ["a column key and a row id", (nul: string): Spec => ({ ...empty(), columns: [{ key: nul.slice(0, 120), title: "T" }], rows: [{ id: nul.slice(0, 120), cells: { [nul.slice(0, 120)]: nul } }] })],
    ["a string value", (nul: string): Spec => ({ ...empty(), fields: [["s", nul]] })],
  ])("keeps %s of 1,500 NUL characters inside collectionBytes=4096", (_what, make) => {
    for (const nul of ["\u0000".repeat(1500), "\"".repeat(1500), "\ud800".repeat(1500), "😀".repeat(1500)]) {
      const graph = publish([make(nul)], { collectionBytes: 4096 });
      expect(emergency, "the ledger and the measure agree").toBe(false);
      expect(bytes(graph), "emitted bytes").toBeLessThanOrEqual(4096);
    }
  });

  // why: D1. The property, over seeded adversarial inputs (escaped, NUL, unicode and lone-surrogate names and keys, huge strings, wide and
  // deep containers, thousands of table rows and so many stored pages): the document never exceeds collectionBytes, no root exceeds
  // rootBytes, and whenever the unbounded document would have been bigger the bounded one says it is partial. Rejects a design in which
  // each helper does its own accounting: some helper always forgets one kind of byte.
  // proves: CLAIM(D1-emitted-bytes)
  it("holds collectionBytes, rootBytes and the partial mark for 80 adversarial captures", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const rng = random(seed);
      NODES.left = 3000;
      const roots = Array.from({ length: between(rng, 1, 3) }, () => spec(rng, 0));
      const limits = limitsFor(rng);
      const graph = publish(roots, limits);
      const unbounded = publish(roots, { rootBytes: 2 * 1024 * 1024 * 1024, collectionBytes: 2 * 1024 * 1024 * 1024, stringBytes: limits.stringBytes as number, pageRows: limits.pageRows as number });
      const where = `seed ${seed} limits ${JSON.stringify(limits)}`;
      expect(emergency, `${where}: the ledger and the measure agree`).toBe(false);
      expect(bytes(graph), `${where}: emitted bytes`).toBeLessThanOrEqual(limits.collectionBytes as number);
      for (const span of rootSpans(graph)) expect(span, `${where}: root bytes`).toBeLessThanOrEqual(limits.rootBytes as number);
      const wouldCut = bytes(unbounded) > (limits.collectionBytes as number) || rootSpans(unbounded).some((span) => span > (limits.rootBytes as number));
      if (wouldCut) expect(graph.completeness.status, `${where}: a cut is marked`).toBe("partial");
    }
  }, 240_000);

  // why: D1. A page body is part of what the capture emits. Thousands of rows with escaped cells spread over hundreds of stored pages must
  // be charged as the page records they become (pageId, owner, index, rows) and still be reported as dropped rows.
  // proves: CLAIM(D1-emitted-bytes)
  it("charges stored page bodies, with their frames, as emitted", () => {
    const rows = Array.from({ length: 3000 }, (_, at) => ({ id: `r${at}`, cells: { c: "\u0000\"\\".repeat(10) } }));
    const graph = publish([{ ...empty(), columns: [{ key: "c", title: "C" }], rows }], { collectionBytes: 20_000, pageRows: 2 });
    expect(bytes(graph)).toBeLessThanOrEqual(20_000);
    const view = graph.views.find((v: any) => v.viewId === "node.rows");
    expect(view.completeness.status).toBe("partial");
    expect(view.completeness.omitted.rows.count).toBe(3000 - view.rowsTotal);
    expect(graph.pages.reduce((n: number, page: any) => n + page.rows.length, 0) + view.data.rows.length).toBe(view.rowsTotal);
  });

  // why: D1. A bound that cannot hold even the empty document is not silently ignored: the capture is empty, says which bound refused it,
  // and the host (which measures the same document) is the one that refuses it. Rejects an implementation that keeps charging a budget
  // that is already below zero.
  // proves: CLAIM(D1-emitted-bytes)
  it("emits an empty marked graph when collectionBytes is below the size of an empty graph", () => {
    const graph = publish([{ ...empty(), fields: [["x", 1]] }], { collectionBytes: 200 });
    expect(graph.objects).toEqual([]);
    expect(graph.roots).toEqual([]);
    expect(graph.completeness.status).toBe("partial");
    expect(graph.completeness.omitted.collectionBytes.count).toBeGreaterThan(0);
  });

  // why: D1. The text the SDK writes is the text it counted: the graph hands out the exact UTF-8 bytes of the document, and its size is what a
  // reader of the file sees.
  // proves: CLAIM(D1-emitted-bytes)
  it("hands out the exact emitted text and its size", () => {
    const capture = new Capture({ limits: specLimits({ collectionBytes: 8192 }) });
    capture.publish({ ...empty(), fields: [["a", "é€😀\u0000"]] }, Node);
    const graph = capture.finish() as unknown as { text: string; bytes: number; toJSON(): unknown };
    expect(graph.text).toBe(JSON.stringify(graph.toJSON()));
    expect(graph.bytes).toBe(Buffer.byteLength(graph.text, "utf8"));
    expect(graph.bytes).toBeLessThanOrEqual(8192);
  });
});

// WHY CLAIM(S25): rejects scalarOf's unbounded display fallback and raw reason tags on 3597bfa.
describe("[S25] display and reason output shares string bounds", () => {
  it.each([["list", [1, 2, 3]], ["redacted", redacted("x".repeat(1000))], ["unsupported", new Unsupported("x".repeat(1000))]])("bounds %s display and reports the omission", (_name, value) => {
    const graph = publish([{ ...empty(), detail: [["v", value as CapturedValue]] }], { stringBytes: 1 });
    const view = graph.views[0];
    expect(Buffer.byteLength(view.data.fields[1].example)).toBeLessThanOrEqual(1);
    expect(view.completeness.omitted.strings.count).toBeGreaterThan(0);
  });
  it("bounds reason tags before emission using both stringBytes and the schema cap", () => {
    const graph = publish([{ ...empty(), fields: [["r", redacted("x".repeat(1000))], ["u", new Unsupported("x".repeat(1000))]] }], { stringBytes: 3 });
    expect(graph.objects[0].fields.r.reason).toBe("xxx");
    expect(graph.objects[0].fields.u.reason).toBe("xxx");
    // Two reason tags and the unsupported rows view reason each lose text.
    expect(graph.completeness.omitted.strings.count).toBe(3);
  });
});

// WHY CLAIM(S25/S26): SDK cuts and host bounds must agree at tiny limits, including tag strings, names, marker keys and display fallbacks.
it.each([1, 3, 256])("[S25/S26] admits bounded SDK tags and names under stringBytes=%i", (stringBytes) => {
  const root = { ...empty(), fields: [["too-long-a-name".repeat(100), 1], ["r", redacted("x".repeat(1000))], ["u", new Unsupported("x".repeat(1000))], ["b", new Uint8Array(1000)], ["i", 9007199254740993n], ["m", { longkey: "long string" }]] as Array<[string, CapturedValue]>, detail: [["v", redacted("x".repeat(1000))]] as Array<[string, CapturedValue]> };
  const graph = publish([root], { stringBytes });
  const result = validateObjectGraph(graph, { expectedRunId: graph.runId, effective: graph.limits });
  expect(result.ok, JSON.stringify(result)).toBe(true);
});
