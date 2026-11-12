import { type Bounded, type Direction, type Json, type Limits, type ObjectRef } from "./types.js";
import { type Charge } from "./bounded.js";
import { type CapturedValue } from "./values.js";
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
export interface CustomBuiltView extends Omit<BuiltView, "component"> {
    readonly component: "custom";
}
export type StandardViewResult = BuiltView | UnsupportedView;
export type ViewResult = StandardViewResult | CustomBuiltView;
export interface RowSpec {
    id: string;
    cells: Record<string, CapturedValue>;
    target?: ObjectRef;
}
/** Measures the view's own computation: wall time minus the time spent publishing children. */
export declare class Budget {
    private readonly nested;
    private readonly limitMs;
    private readonly started;
    private readonly nestedAtStart;
    constructor(nested: {
        ms: number;
    }, limitMs: number);
    over(): number | undefined;
}
import { canonicalJson } from "./canonical.js";
export { canonicalJson };
export declare const sha256Hex: (text: string) => string;
export declare class DetailsBuilder {
    private readonly limits;
    private readonly budget;
    private readonly charge;
    private readonly fields;
    private omitted;
    constructor(limits: Limits, budget: Budget, charge: Charge);
    /** Fluent. When the builder is full the field is refused and counted; the omission shows in the view's completeness. */
    field(name: string, value: CapturedValue): this;
    done(): StandardViewResult;
}
export declare class TableBuilder {
    private readonly limits;
    private readonly budget;
    private readonly charge;
    private readonly pageFrame;
    private readonly columns;
    private order;
    private readonly rows;
    private omitted;
    constructor(limits: Limits, budget: Budget, charge: Charge, pageFrame: (index: number) => number);
    textColumn(key: string, title: string): this;
    numberColumn(key: string, title: string): this;
    booleanColumn(key: string, title: string): this;
    /** Records the order and sorts rows by that column, stable (equal keys keep insertion order). */
    orderBy(key: string, direction: Direction): this;
    row(spec: RowSpec): Bounded;
    done(): StandardViewResult;
}
