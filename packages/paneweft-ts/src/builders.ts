// Context-owned, bounded builders (spec amendment S5): row() stops accepting at the limit and returns the omission count;
// exhaustion gives partial output, never a failed view. Lowering follows docs/v1-red-contract.md section 3.
import { createHash } from "node:crypto";
import { ViewError, type Bounded, type Direction, type Json, type Limits, type ObjectRef } from "./types.ts";
import { emit, type Charge } from "./bounded.ts";
import { exceedsCodePoints, newStats, scalarOf, typeName, type CapturedValue, type EncodeStats } from "./values.ts";

export interface BuiltPage {
  pageId: string;
  rows: Json[];
}

export interface BuiltView {
  readonly kind: "built";
  readonly component: "shape" | "list";
  /** The v0 component data of the first page. */
  readonly data: Json;
  readonly pages?: ReadonlyArray<BuiltPage>;
  /** Rows retained over all pages (lists only). */
  readonly rowsTotal?: number;
  /** Omissions by name (`rows`, `strings`) as counts. */
  readonly omitted?: Readonly<Record<string, number>>;
  /** Milliseconds of the view's own computation when it exceeded the cooperative budget. */
  readonly overBudgetMs?: number;
}
export interface UnsupportedView {
  readonly kind: "unsupported";
  readonly reason: string;
}
export type ViewResult = BuiltView | UnsupportedView;

export interface RowSpec {
  id: string;
  cells: Record<string, CapturedValue>;
  target?: ObjectRef;
}

/** Measures the view's own computation: wall time minus the time spent publishing children. */
export class Budget {
  private readonly started = performance.now();
  private readonly nestedAtStart: number;
  constructor(private readonly nested: { ms: number }, private readonly limitMs: number) {
    this.nestedAtStart = nested.ms;
  }
  over(): number | undefined {
    const own = performance.now() - this.started - (this.nested.ms - this.nestedAtStart);
    return own > this.limitMs ? Math.floor(own) : undefined;
  }
}

const evidence = (): Json => ["run"];

function validId(kind: string, text: string): void {
  if (text.length === 0 || exceedsCodePoints(text, 120)) throw new ViewError("output-schema", `${kind} ${JSON.stringify(text)} must be 1 to 120 characters`);
}

/** Canonical JSON: keys sorted at every level (code-unit order), the text a page id and a content hash cover. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    return item;
  };
  return JSON.stringify(sort(value));
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function omissions(rows: number, strings: number): Record<string, number> | undefined {
  const omitted: Record<string, number> = {};
  if (rows > 0) omitted.rows = rows;
  if (strings > 0) omitted.strings = strings;
  return Object.keys(omitted).length === 0 ? undefined : omitted;
}

/** A view that cannot even hold its frame in the byte budget says so instead of failing. */
const NO_ROOM = "the byte budget of this capture is used up: the view could not be built";

export class DetailsBuilder {
  private readonly fields: Array<[string, CapturedValue]> = [];
  private omitted = 0;
  constructor(private readonly limits: Limits, private readonly budget: Budget, private readonly charge: Charge) {}

  /** Fluent. When the builder is full the field is refused and counted; the omission shows in the view's completeness. */
  field(name: string, value: CapturedValue): this {
    if (this.fields.length >= this.limits.viewRows) this.omitted += 1;
    else this.fields.push([name, value]);
    return this;
  }

  done(): ViewResult {
    const stats: EncodeStats = newStats();
    const seen = new Set<string>();
    const leaves: Json[] = [];
    const children: string[] = [];
    const root = (ids: string[]): Json => ({ id: "details", path: "$", type: "object", presence: "required", children: ids, provenance: "observed", evidence: evidence() });
    // the frame of the shape (root field, basis, root) is charged first; each field is then charged by the text it becomes (S2)
    if (!this.charge.take(emit({ basis: "observed", root: "details", fields: [root([])] }).bytes)) return { kind: "unsupported", reason: NO_ROOM };
    let kept = 0;
    for (const [name, value] of this.fields) {
      validId("field name", name);
      if (seen.has(name)) throw new ViewError("output-schema", `duplicate field name ${JSON.stringify(name)}: field names are the leaf ids of one shape`);
      seen.add(name);
      const id = `details.${name}`;
      const leaf: Json = { id, path: `$.${name}`, type: typeName(value), presence: "required", example: scalarOf(value, this.limits, stats), children: [], provenance: "observed", evidence: evidence() };
      // the leaf in `fields` and its id in the root's `children`, each after a comma but the first id
      if (!this.charge.take(emit(leaf).bytes + 1 + emit(id).bytes + (kept > 0 ? 1 : 0))) break;
      children.push(id);
      leaves.push(leaf);
      kept += 1;
    }
    this.omitted += this.fields.length - kept;
    const fields: Json[] = [root(children), ...leaves];
    const omitted = omissions(this.omitted, stats.strings);
    const over = this.budget.over();
    return { kind: "built", component: "shape", data: { basis: "observed", root: "details", fields }, ...(omitted === undefined ? {} : { omitted }), ...(over === undefined ? {} : { overBudgetMs: over }) };
  }
}

type Format = "text" | "number" | "boolean";

/** Null < boolean < number < string; numbers numerically, strings by code point. A total order, so the sort is deterministic. */
function compareCells(left: Json, right: Json): number {
  const rank = (value: Json): number => (value === null ? 0 : typeof value === "boolean" ? 1 : typeof value === "number" ? 2 : 3);
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "string" && typeof right === "string") {
    const a = [...left];
    const b = [...right];
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      const delta = (a[index] as string).codePointAt(0)! - (b[index] as string).codePointAt(0)!;
      if (delta !== 0) return delta;
    }
    return a.length - b.length;
  }
  return rank(left) - rank(right);
}

export class TableBuilder {
  private readonly columns: Array<{ key: string; title: string; format: Format }> = [];
  private order: { key: string; direction: Direction } | undefined;
  private readonly rows: RowSpec[] = [];
  private omitted = 0;
  constructor(private readonly limits: Limits, private readonly budget: Budget, private readonly charge: Charge, private readonly pageFrame: (index: number) => number) {}

  textColumn(key: string, title: string): this {
    this.columns.push({ key, title, format: "text" });
    return this;
  }
  numberColumn(key: string, title: string): this {
    this.columns.push({ key, title, format: "number" });
    return this;
  }
  booleanColumn(key: string, title: string): this {
    this.columns.push({ key, title, format: "boolean" });
    return this;
  }
  /** Records the order and sorts rows by that column, stable (equal keys keep insertion order). */
  orderBy(key: string, direction: Direction): this {
    this.order = { key, direction };
    return this;
  }

  row(spec: RowSpec): Bounded {
    if (this.rows.length >= this.limits.viewRows) {
      this.omitted += 1;
      return { accepted: false, omittedSoFar: this.omitted };
    }
    this.rows.push(spec);
    return { accepted: true };
  }

  done(): ViewResult {
    if (this.columns.length === 0) throw new ViewError("output-schema", "a table needs at least one column: call textColumn, numberColumn or booleanColumn");
    const keys = new Set<string>();
    for (const column of this.columns) {
      validId("column key", column.key);
      if (column.title.length === 0) throw new ViewError("output-schema", `column ${JSON.stringify(column.key)} needs a title`);
      // a title is a label of at most 256 characters in the list schema; a longer one would fail the whole view at the host
      if (exceedsCodePoints(column.title, 256)) throw new ViewError("output-schema", `the title of column ${JSON.stringify(column.key)} must be 1 to 256 characters`);
      if (keys.has(column.key)) throw new ViewError("output-schema", `duplicate column key ${JSON.stringify(column.key)}`);
      keys.add(column.key);
    }
    // Without orderBy the table is ordered by its first column ascending, and says so: the recorded order is always true.
    const order = this.order ?? { key: (this.columns[0] as { key: string }).key, direction: "asc" as Direction };
    if (!keys.has(order.key)) throw new ViewError("output-schema", `orderBy names ${JSON.stringify(order.key)}, which is not a declared column`);
    const stats: EncodeStats = newStats();
    const ids = new Set<string>();
    const rendered: Array<{ sort: Json; row: Json }> = [];
    // The frame (columns, order, the list record) is charged first. Rows are then charged in insertion order by the text they become, a stored
    // page's own frame at the first row it holds, and the rows that no longer fit are dropped and counted (S2): stored page bodies count like
    // first-page rows.
    const pageRows = Math.max(1, this.limits.pageRows);
    const columns = this.columns.map((column) => ({ key: column.key, title: column.title, format: column.format }));
    if (!this.charge.take(emit({ columns, rows: [], order }).bytes)) return { kind: "unsupported", reason: NO_ROOM };
    for (const spec of this.rows) {
      validId("row id", spec.id);
      if (ids.has(spec.id)) throw new ViewError("output-schema", `duplicate row id ${JSON.stringify(spec.id)}: row ids are occurrence ids and must be unique`);
      ids.add(spec.id);
      const cells: Record<string, Json> = {};
      for (const [key, value] of Object.entries(spec.cells)) {
        if (!keys.has(key)) throw new ViewError("output-schema", `row ${JSON.stringify(spec.id)} has a cell ${JSON.stringify(key)} that no column declares`);
        cells[key] = scalarOf(value, this.limits, stats);
      }
      const row: { [key: string]: Json } = { id: spec.id, cells, provenance: "observed", evidence: evidence() };
      if (spec.target !== undefined) row.target = spec.target as Json;
      const at = rendered.length;
      const startsPage = at >= pageRows && at % pageRows === 0;
      if (!this.charge.take(emit(row).bytes + (at % pageRows === 0 ? 0 : 1) + (startsPage ? this.pageFrame(at / pageRows) : 0))) {
        this.omitted += this.rows.length - rendered.length;
        break;
      }
      rendered.push({ sort: cells[order.key] ?? null, row });
    }
    const sign = order.direction === "desc" ? -1 : 1;
    // Array.prototype.sort is stable (ES2019), so equal keys keep insertion order in both directions.
    rendered.sort((a, b) => sign * compareCells(a.sort, b.sort));
    const rows = rendered.map((entry) => entry.row);
    const pages: BuiltPage[] = [];
    for (let at = pageRows; at < rows.length; at += pageRows) {
      // Stored page rows are canonical (keys sorted at every level) so the content address is the hash of exactly the stored text.
      const chunk = (JSON.parse(canonicalJson(rows.slice(at, at + pageRows))) as Json[]);
      pages.push({ pageId: `sha256:${sha256Hex(JSON.stringify(chunk))}`, rows: chunk });
    }
    const omitted = omissions(this.omitted, stats.strings);
    const over = this.budget.over();
    return { kind: "built", component: "list", data: { columns, rows: rows.slice(0, pageRows), order }, pages, rowsTotal: rows.length, ...(omitted === undefined ? {} : { omitted }), ...(over === undefined ? {} : { overBudgetMs: over }) };
  }
}
