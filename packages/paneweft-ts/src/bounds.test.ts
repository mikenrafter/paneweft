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
      expect(graph.completeness.omitted.values.count).toBeGreaterThan(1000);
      expect(performance.now() - started, "milliseconds").toBeLessThan(2500);
    }
  });

  // why: S2. A string longer than the room left is cut to it, not just to stringBytes.
  // proves: CLAIM(S2-budgets)
  it("cuts a string to the room that is left", () => {
    const graph = publish({ items: "x".repeat(1_000_000) }, { collectionBytes: 1024 });
    expect(charged(graph)).toBeLessThanOrEqual(1024);
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
