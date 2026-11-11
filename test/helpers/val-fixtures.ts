// Valid base documents, size padding and nesting builders for the validation suites (tag: val).
// Every base differs from a committed fixture only by added items; each is accepted by a positive control
// in the suite that uses it, so a negative built from it differs from a valid document by one fault.
import { allBundle, clone, componentFixture } from "./fixtures.ts";

type Doc = Record<string, any>;

export const HASH = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

/** A minimal item: provenance read, evidence the fixtures' file source `s1`. */
export function item(id: string, extra: Doc = {}): Doc {
  return { id, provenance: "read", evidence: ["s1"], ...extra };
}

/** A source with a run id (the only thing that makes an `observed` item acceptable). */
export function runSource(id = "s2", runId = "run-1"): Doc {
  return {
    id,
    kind: "command",
    sha256: HASH,
    capturedAt: "2026-11-11T00:00:00Z",
    method: "cargo test --test mcp_e2e",
    runId,
    argv: ["cargo", "test"],
    exitCode: 0,
  };
}

/** S4: a `run` source - one execution of an owner-configured runner. Snake_case members are the round-2 contract. */
export function runKindSource(id = "s3", runId = "run-1", extra: Doc = {}): Doc {
  return { id, kind: "run", run_id: runId, runner_id: "vigil-one-write", started_at: "2026-11-11T00:00:00Z", finished_at: "2026-11-11T00:00:02Z", ...extra };
}

/** S4: a `tool` source - the compiler or language service behind `compiled` facts. */
export function toolSource(id = "s4", extra: Doc = {}): Doc {
  return { id, kind: "tool", name: "rustc", version: "1.91.0", ...extra };
}

export function listBase(): Doc {
  const view = componentFixture("list");
  view.data.rows.push(item("second", { cells: { name: "watch.rs" } }));
  return view;
}

/** Three nodes in a cycle a->b->c->a, path p = e1,e2 (contiguous), focus on a. Cycles are legal (design 2.3). */
export function graphBase(): Doc {
  const view = componentFixture("graph");
  view.data = {
    nodes: [item("a", { label: "MCP" }), item("b", { label: "Engine" }), item("c", { label: "Store" })],
    edges: [
      item("e1", { from: "a", to: "b", relation: "invokes" }),
      item("e2", { from: "b", to: "c", relation: "invokes" }),
      item("e3", { from: "c", to: "a", relation: "invokes" }),
    ],
    layout: "layered",
    focus: { node: "a", direction: "out", depth: 2 },
    paths: [{ id: "p", edgeIds: ["e1", "e2"] }],
  };
  return view;
}

/** Root a -> b -> c, plus a second occurrence `a2` of the same entity as `a` (allowed, design 2.2). */
export function treeBase(): Doc {
  const view = componentFixture("tree");
  const entity = { repository: "r", id: "mcp", kind: "code/module" };
  const node = (id: string, children: string[], extra: Doc = {}) =>
    item(id, { cells: { name: id }, children, childrenState: "complete", ...extra });
  view.data = {
    columns: [{ key: "name", title: "Name", format: "text" }],
    roots: ["a"],
    nodes: [node("a", ["b"], { entity }), node("b", ["c", "a2"]), node("c", []), node("a2", [], { entity })],
  };
  return view;
}

/** Excerpt of lines 4..6 of src/check.ts and one annotation on line 4. */
export function sourceBase(): Doc {
  const view = componentFixture("source");
  view.data.excerpt.anchor.lines = [4, 6];
  view.data.excerpt.text = "if (!allowed) return denied;\nlog(denied);\nreturn ok;";
  return view;
}

export function shapeBase(): Doc {
  const view = componentFixture("shape");
  view.data = {
    basis: "declared",
    root: "f",
    fields: [
      item("f", { path: "watch", type: "object", presence: "required", children: ["g"] }),
      item("g", { path: "watch.parent", type: "watch", presence: "optional", children: [], ref: "f", example: null }),
    ],
  };
  return view;
}

/** prose b1, view block b2, claim c1 citing source s1, and example block x1. */
export function notebookBase(): Doc {
  const view = componentFixture("notebook");
  view.data.blocks.push(
    item("c1", { kind: "claim", statement: "Cancellation is checked first.", status: "supported", supports: ["s1"], contradicts: [] }),
    item("x1", { kind: "example", exampleId: "once" }),
  );
  return view;
}

export function passedRun(overrides: Doc = {}): Doc {
  return item("run-a", {
    runId: "run-1",
    status: "passed",
    assertions: [item("as-1", { statement: "status is fired", passed: true })],
    result: { repository: "r", id: "res", kind: "json/value" },
    provenance: "observed",
    evidence: ["s2"],
    ...overrides,
  });
}

/** The example fixture with the `run` source `s2` (run id run-1) and one passed run. N2: an observed run is honest only through a `run` source. */
export function exampleBase(runs: Doc[] = [passedRun()]): Doc {
  const view = componentFixture("example");
  view.sources.push(runKindSource("s2", "run-1"));
  view.data.runs = runs;
  return view;
}

// ---- sizes -----------------------------------------------------------------------------------------------------

export const MIB = 1024 * 1024;

export function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const PAD_CELL_MAX = 60_000;

function padRow(index: number, pad: string): Doc {
  return item(`pad${String(index).padStart(3, "0")}`, { cells: { name: pad } });
}

/**
 * Appends padding rows to a list view so that `JSON.stringify(view)` is EXACTLY `target` UTF-8 bytes.
 * Arithmetic: each added row costs `overhead` = bytes(row with an empty cell) + 1 comma, plus its cell length.
 * With remaining R = target - bytes(view) and n = ceil(R / (60000 + overhead)) rows, the cells carry
 * R - n*overhead characters in total, spread so that no cell exceeds 60000 (< the 64 KiB string limit).
 */
export function padListView(view: Doc, target: number): Doc {
  const doc = clone(view);
  const remaining = target - bytes(doc);
  if (remaining < 0) throw new Error(`padListView: view is already ${bytes(doc)} bytes, target ${target}`);
  if (remaining === 0) return doc;
  const overhead = bytes(padRow(0, "")) + 1;
  const rows = Math.ceil(remaining / (PAD_CELL_MAX + overhead));
  const totalPad = remaining - rows * overhead;
  if (totalPad < 0) throw new Error("padListView: target too close to the current size to pad exactly");
  const base = Math.floor(totalPad / rows);
  const extra = totalPad % rows;
  for (let index = 0; index < rows; index++) {
    doc.data.rows.push(padRow(index, "x".repeat(base + (index < extra ? 1 : 0))));
  }
  if (bytes(doc) !== target) throw new Error(`padListView: built ${bytes(doc)} bytes, wanted ${target}`);
  return doc;
}

/**
 * The complete fixture bundle plus four padded list views (big-1..big-4, each below 2 MiB) so that
 * `JSON.stringify(bundle)` is EXACTLY `target` bytes.
 */
export function paddedBundle(target: number): Doc {
  const bundle = allBundle();
  const template = componentFixture("list");
  const bigViews: Doc[] = [1, 2, 3, 4].map((n) => ({ ...clone(template), id: `big-${n}` }));
  bundle.views.push(...bigViews);
  const remaining = target - bytes(bundle);
  if (remaining < 0) throw new Error("paddedBundle: target below the unpadded bundle size");
  const share = Math.floor(remaining / 4);
  const extra = remaining % 4;
  const firstBig = bundle.views.length - 4;
  for (let n = 0; n < 4; n++) {
    const index = firstBig + n;
    const view = bundle.views[index];
    bundle.views[index] = padListView(view, bytes(view) + share + (n < extra ? 1 : 0));
  }
  if (bytes(bundle) !== target) throw new Error(`paddedBundle: built ${bytes(bundle)} bytes, wanted ${target}`);
  return bundle;
}

// ---- nesting ---------------------------------------------------------------------------------------------------

/** `wrappers` nested arrays: [[[...[]...]]] where the innermost is empty. wrappers=1 is `[]`. */
export function nestedArrays(wrappers: number): unknown {
  let value: unknown = [];
  for (let level = 1; level < wrappers; level++) value = [value];
  return value;
}

/** `wrappers` nested objects {"a":{"a":...{}}}; wrappers=1 is `{}`. */
export function nestedObjects(wrappers: number): unknown {
  let value: unknown = {};
  for (let level = 1; level < wrappers; level++) value = { a: value };
  return value;
}
