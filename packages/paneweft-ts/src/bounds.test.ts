// Fix round 1, S2 and S3: the byte budgets are charged while the graph is built, and a caller can only lower a bound.
import { describe, expect, it } from "vitest";
import { Capture, applyLimitOverrides, defaultLimits, defineType, type Limits } from "./index.ts";
import { limitsFromEnv } from "./artifacts.ts";
import { specLimits } from "../test/support.ts";

const Big = defineType<{ items: unknown; rows?: number }>({ id: "t::Big", source: { path: "bounds.test.ts", symbol: "Big" } });
Big.view({
  id: "big.details", title: "Big", question: "What does the object hold?", priority: 1, component: "shape",
  render: (value, view) => { view.field("items", value.items as never); return view.details().field("kind", "big").done(); },
});
Big.view({
  id: "big.rows", title: "Rows", question: "Which rows?", priority: 2, component: "list",
  render: (value, view) => {
    const table = view.table().textColumn("n", "N").numberColumn("v", "V");
    for (let i = 0; i < (value.rows ?? 0); i += 1) table.row({ id: `r${i}`, cells: { n: `row ${i}`, v: i } });
    return table.done();
  },
});

const bytes = (json: unknown): number => Buffer.byteLength(JSON.stringify(json), "utf8");
/** What the budgets cover: the object records, the view records with their data, the stored page bodies and the diagnostics. */
const charged = (graph: any): number => bytes(graph.objects) + bytes(graph.views) + bytes(graph.pages) + bytes(graph.diagnostics);
const publish = (value: unknown, limits: Partial<Limits>) => {
  const capture = new Capture({ limits: specLimits(limits) });
  capture.publish(value, Big);
  return capture.finish().toJSON() as any;
};
const numbers = (count: number): number[] => Array.from({ length: count }, (_, i) => i);

describe("[S2] byte budgets are charged while the graph is built", () => {
  // why: S2. A 20,000-element field under collectionBytes=2048 produced 25 KB and reported the capture complete, because the bytes were
  // measured after the object was built and the field was never limited. Rejects an implementation that sums sizes after construction.
  // proves: CLAIM(S2-budgets)
  it("keeps the whole collection within collectionBytes and says what was cut", () => {
    const graph = publish({ items: numbers(20_000) }, { collectionBytes: 2048 });
    expect(charged(graph)).toBeLessThanOrEqual(2048);
    expect(graph.completeness.status).toBe("partial");
    expect(graph.completeness.omitted.values.count).toBeGreaterThan(19_000);
    const items = graph.objects[0].fields.items;
    expect(items.at(-1)).toEqual({ $paneweft: "not-captured", reason: "collection-limit" });
    expect(items.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  // why: S2. rootBytes bounds one root's subtree the same way, and its marker names the root budget.
  // proves: CLAIM(S2-budgets)
  it("keeps a root within rootBytes", () => {
    const graph = publish({ items: numbers(20_000) }, { rootBytes: 1500 });
    expect(charged(graph)).toBeLessThanOrEqual(1500);
    expect(graph.completeness.status).toBe("partial");
    expect(graph.objects[0].fields.items.at(-1)).toEqual({ $paneweft: "not-captured", reason: "root-bytes-limit" });
  });

  // why: S2. Stored page bodies were excluded from the accounting, so a table of 5,000 rows under a small budget stored every row in pages.
  // They are charged like first-page rows; the rows that do not fit are dropped and counted, never silently.
  // proves: CLAIM(S2-budgets)
  it("charges stored page bodies and drops the rows that do not fit", () => {
    const graph = publish({ items: 1, rows: 5000 }, { collectionBytes: 12_000, pageRows: 10 });
    expect(charged(graph)).toBeLessThanOrEqual(12_000);
    const view = graph.views.find((v: any) => v.viewId === "big.rows");
    expect(view.rowsTotal).toBeLessThan(5000);
    expect(view.completeness.status).toBe("partial");
    expect(view.completeness.omitted.rows.count).toBe(5000 - view.rowsTotal);
    expect(graph.pages.reduce((n: number, page: any) => n + page.rows.length, 0) + view.data.rows.length).toBe(view.rowsTotal);
  });

  // why: S2. Both encoders walked whatever container they were given. A sparse array of 2^31 slots, an object of 200,000 members and a map
  // of 200,000 entries are cut after the budget, in time proportional to the output (the walk of a huge array is not the output).
  // proves: CLAIM(S2-budgets)
  it("does not walk a container past its budget", () => {
    const sparse = new Array(2 ** 31);
    const wide: Record<string, number> = {};
    for (let i = 0; i < 200_000; i += 1) wide[`k${i}`] = i;
    const map = new Map<string, number>(Array.from({ length: 200_000 }, (_, i) => [`m${i}`, i]));
    for (const items of [sparse, wide, map]) {
      const started = performance.now();
      const graph = publish({ items }, { collectionBytes: 4096 });
      expect(charged(graph)).toBeLessThanOrEqual(4096);
      // an object's walk stops with the budget, so what it left is unknown (S2, round 2); an array and a Map know their size
      if (items === wide) expect(graph.completeness.omitted.values).toEqual({ known: false, count: null });
      else expect(graph.completeness.omitted.values.count).toBeGreaterThan(1000);
      expect(performance.now() - started, "milliseconds").toBeLessThan(2500);
    }
  });

  // why: S2. A string longer than the room left is cut to it, not just to stringBytes.
  // proves: CLAIM(S2-budgets)
  it("cuts a string to the room that is left", () => {
    const graph = publish({ items: "x".repeat(1_000_000) }, { collectionBytes: 4096 });
    expect(charged(graph)).toBeLessThanOrEqual(4096);
    expect(graph.objects[0].fields.items.$paneweft).toBe("truncated");
    expect(graph.completeness.status).toBe("partial");
  });

  // why: control. With room to spare nothing is cut and the capture is complete: the budget changes nothing it does not have to.
  // proves: CLAIM(S2-budgets)
  it("is complete and unchanged when everything fits", () => {
    const graph = publish({ items: numbers(50) }, {});
    expect(graph.completeness).toEqual({ status: "complete" });
    expect(graph.objects[0].fields.items).toEqual(numbers(50));
  });
});

describe("[S3] a caller can only lower a bound", () => {
  // why: S3. Overrides replaced the limits, so an untrusted collect payload could ask for 2^40 bytes or a billion objects. Rejects the
  // implementation that assigns any non-negative integer.
  // proves: CLAIM(S3-clamp)
  it("never raises a bound above the operator's number", () => {
    const base = defaultLimits();
    const raised = applyLimitOverrides(base, { objects: 10 ** 9, collectionBytes: 2 ** 40, rootBytes: 2 ** 40, depth: 99, viewBudgetMs: 10 ** 9, stringBytes: 2 ** 31, pageRows: 5000, roots: 10 ** 6, references: 10 ** 8, viewRows: 10 ** 9 });
    expect(raised).toEqual(base);
  });

  // why: S3. Lowering still works, to the schema minimum at the least; a ceiling below the defaults (an operator who allows less) wins.
  // proves: CLAIM(S3-clamp)
  it("lowers a bound, to the minimum at least, and honours a lower ceiling", () => {
    const base = defaultLimits();
    expect(applyLimitOverrides(base, { objects: 5, depth: 0, pageRows: 0 })).toMatchObject({ objects: 5, depth: 0, pageRows: 1 });
    expect(applyLimitOverrides(base, { objects: 500 }, { ...base, objects: 50 }).objects).toBe(50);
  });

  // why: S3. A name or a value that is not a valid bound is ignored, not coerced: floats, negatives, strings, NaN, unsafe integers, an
  // inherited name, and an override that is not an object at all.
  // proves: CLAIM(S3-clamp)
  it("ignores everything that is not an integer bound", () => {
    const base = defaultLimits();
    expect(applyLimitOverrides(base, { objects: 1.5, depth: -1, roots: "5" as never, references: Number.NaN, rootBytes: 2 ** 60, bogus: 3 } as never)).toEqual(base);
    expect(applyLimitOverrides(base, null as never)).toEqual(base);
    expect(applyLimitOverrides(base, [7] as never)).toEqual(base);
    expect(applyLimitOverrides(base, Object.create({ objects: 1 }) as never)).toEqual(base);
  });

  // why: S3. The environment variable the host sets is the same untrusted channel: a payload-derived value above the defaults has no effect.
  // proves: CLAIM(S3-clamp)
  it("reads PANEWEFT_LIMITS through the same clamp", () => {
    expect(limitsFromEnv({ PANEWEFT_LIMITS: JSON.stringify({ collectionBytes: 2 ** 45, objects: 3 }) })).toEqual({ ...defaultLimits(), objects: 3 });
  });
});

// ---- fix round 2 ----------------------------------------------------------------------------------------------------------------------

const hugeKey = "K".repeat(100_000);

describe("[S2r2] a key is admitted only if it fits what is left, and enumeration stops with the budget", () => {
  // why: S2 (round 2). The Map branch charged `jsonBytes(key)` and kept the key whether or not it fitted: a 100,000-character key under a
  // 4,096-byte budget produced 100,905 bytes. Rejects an implementation that spends a key's bytes before asking whether they fit.
  // proves: CLAIM(S2-budgets)
  it.each([
    ["a Map", () => new Map<string, unknown>([["a", 1], [hugeKey, 2], ["b", 3]])],
    ["an object", () => ({ a: 1, [hugeKey]: 2, b: 3 })],
  ])("drops a 100,000-character key in %s and stops there", (_name, make) => {
    const graph = publish({ items: make() }, { collectionBytes: 4096 });
    expect(charged(graph)).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(graph)).not.toContain("KKKKKKKKKK");
    const items = graph.objects[0].fields.items;
    expect(items.a).toBe(1);
    expect(items["…"]).toEqual({ $paneweft: "not-captured", reason: "collection-limit" });
    expect(graph.completeness.status).toBe("partial");
    expect(graph.completeness.omitted.values).toBeDefined();
  });

  // why: S2 (round 2). The first key of a container too big for the budget: nothing of it is kept, the container says so.
  // proves: CLAIM(S2-budgets)
  it.each([
    ["a Map", () => new Map<string, unknown>([[hugeKey, 1]])],
    ["an object", () => ({ [hugeKey]: 1 })],
  ])("keeps nothing of %s whose only key does not fit", (_name, make) => {
    const graph = publish({ items: make() }, { collectionBytes: 4096 });
    expect(charged(graph)).toBeLessThanOrEqual(4096);
    expect(graph.objects[0].fields.items).toEqual({ "…": { $paneweft: "not-captured", reason: "collection-limit" } });
  });

  // why: S2 (round 2). `Object.keys` listed every member of an object before the first byte was charged. A Proxy counts what the encoder
  // asks of the object: 200,000 keys under a 4,096-byte budget must cost a few thousand property reads at most, not one per key.
  // Rejects an implementation that materializes the key list first.
  // proves: CLAIM(S2-budgets)
  it("does not ask for the property of every key of a huge object", () => {
    const keys = Array.from({ length: 200_000 }, (_, i) => `k${i}`);
    let reads = 0;
    const proxy = new Proxy({} as Record<string, number>, {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: () => { reads += 1; return { value: 1, enumerable: true, configurable: true, writable: true }; },
    });
    const graph = publish({ items: proxy }, { collectionBytes: 4096 });
    expect(charged(graph)).toBeLessThanOrEqual(4096);
    expect(reads, "property reads").toBeLessThan(2000);
    expect(graph.completeness.status).toBe("partial");
  });

  // why: S2 (round 2). When the walk of an object stops early the number left is not known; saying a number would be a guess. The omission is
  // recorded as unknown, never as a count the capture did not make.
  // proves: CLAIM(S2-budgets)
  it("records an object cut short as an unknown omission, and a Map (whose size is known) as a count", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5000; i += 1) wide[`k${i}`] = i;
    const cut = publish({ items: wide }, { collectionBytes: 2048 });
    expect(cut.completeness.omitted.values).toEqual({ known: false, count: null });
    const map = publish({ items: new Map(Object.entries(wide)) }, { collectionBytes: 2048 });
    expect(map.completeness.omitted.values.known).toBe(true);
    expect(map.completeness.omitted.values.count).toBeGreaterThan(4000);
  });

  // why: S2 (round 2), siblings. A label longer than 256 bytes was kept whole in memory, a domain key longer than 256 characters made the
  // whole graph fail the host's schema (domainKey maxLength 256), and a column title longer than 256 characters did the same to the view.
  // proves: CLAIM(S2-budgets)
  it("keeps no label, domain key or column title longer than the schema allows", () => {
    const capture = new Capture({ limits: specLimits({}) });
    const Keyed = defineType<{ n: number }>({ id: "t::Keyed", source: { path: "bounds.test.ts", symbol: "Keyed" } });
    Keyed.view({ id: "keyed.t", title: "T", question: "Q?", priority: 1, component: "list", render: (_v, view) => {
      view.label("L".repeat(100_000));
      return view.table().textColumn("a", "T".repeat(300)).done();
    } });
    const parent = defineType<{ n: number }>({ id: "t::Parent", source: { path: "bounds.test.ts", symbol: "Parent" } });
    parent.view({ id: "parent.t", title: "P", question: "Q?", priority: 1, component: "shape", render: (_v, view) => { view.reference({ n: 1 }, Keyed, { key: "d".repeat(1000) }); return view.details().field("x", 1).done(); } });
    capture.publish({ n: 1 }, parent);
    const graph = capture.finish().toJSON() as any;
    const child = graph.objects[1];
    expect(child.domainKey.length).toBeLessThanOrEqual(256);
    expect(child.label.length).toBeLessThanOrEqual(256);
    expect(graph.diagnostics.map((d: any) => d.category)).toContain("output-schema");
  });

  // why: S2 (round 2), sibling. A field named `__proto__` was assigned to the prototype of the field record: its bytes were charged and the
  // field vanished without a word.
  // proves: CLAIM(S2-budgets)
  it("keeps a field named __proto__ as a field", () => {
    const Proto = defineType<{ n: number }>({ id: "t::Proto", source: { path: "bounds.test.ts", symbol: "Proto" } });
    Proto.view({ id: "proto.d", title: "D", question: "Q?", priority: 1, component: "shape", render: (_v, view) => { view.field("__proto__", 7); view.field("plain", 1); return view.details().field("x", 1).done(); } });
    const capture = new Capture({ limits: specLimits({}) });
    capture.publish({ n: 1 }, Proto);
    const graph = JSON.parse(JSON.stringify(capture.finish().toJSON()));
    expect(Object.keys(graph.objects[0].fields).sort()).toEqual(["__proto__", "plain"]);
  });
});
