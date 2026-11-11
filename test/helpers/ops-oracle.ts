// Independent oracles for the operation-layer tests (tag: ops). Everything here is a small, obviously
// correct reference model written WITHOUT importing anything from src/: UTF-8 clipping, value ordering,
// the list filter, search ranking, tree "context" ancestors and a cursor-chain follower. Each function has
// hand-checked cases in test/helpers/ops-oracle.test.ts, so a wrong oracle is caught before it can bless
// (or condemn) an implementation.
import { assert } from "vitest";

export type Scalar = string | number | boolean | null;

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Bytes of one code point, computed from the code point itself (not via Buffer) so it is an independent check. */
export function codePointBytes(codePoint: number): 1 | 2 | 3 | 4 {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** The longest prefix of `text` made of whole code points whose UTF-8 encoding is at most `maxBytes`. */
export function clipToBytes(text: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const character of text) {
    const size = codePointBytes(character.codePointAt(0) as number);
    if (used + size > maxBytes) break;
    used += size;
    out += character;
  }
  return out;
}

/** True when `text` survives a UTF-8 round trip through a fatal decoder unchanged and holds no U+FFFD. */
export function isWellFormedUtf8Text(text: string): boolean {
  if (text.includes("\uFFFD")) return false;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "utf8"));
    return decoded === text;
  } catch {
    return false;
  }
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TYPE_RANK = { null: 0, boolean: 1, number: 2, string: 3 } as const;
function typeRank(value: Scalar): number {
  return value === null ? TYPE_RANK.null : TYPE_RANK[typeof value as "boolean" | "number" | "string"];
}
/** Scalars: null < booleans (false < true) < numbers (numeric) < strings (UTF-16 code-unit order). */
export function compareScalar(a: Scalar, b: Scalar): number {
  const byType = typeRank(a) - typeRank(b);
  if (byType !== 0) return byType < 0 ? -1 : 1;
  if (a === null || b === null) return 0;
  if (typeof a === "string") return compareCodeUnits(a, b as string);
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface OracleRow {
  id: string;
  label?: string;
  cells: Record<string, Scalar>;
  provenance: string;
  [extra: string]: unknown;
}

/** red-contract section 3: the view's (or request's) order, then item id in code-unit order, whatever the direction. */
export function orderRows<T extends OracleRow>(rows: readonly T[], order: { key: string; direction: "asc" | "desc" }): T[] {
  const sign = order.direction === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const byKey = compareScalar(x.cells[order.key] ?? null, y.cells[order.key] ?? null) * sign;
    return byKey !== 0 ? byKey : compareCodeUnits(x.id, y.id);
  });
}

export interface ListFilter {
  text?: string;
  columns?: Record<string, Scalar>;
  provenance?: readonly string[];
}

/** red-contract section 3 filter members (AND): text = case-insensitive substring of label or any STRING cell. */
export function filterRows<T extends OracleRow>(rows: readonly T[], filter: ListFilter): T[] {
  return rows.filter((row) => {
    if (filter.text !== undefined) {
      const needle = filter.text.toLowerCase();
      const haystacks = [row.label, ...Object.values(row.cells)].filter((value): value is string => typeof value === "string");
      if (!haystacks.some((value) => value.toLowerCase().includes(needle))) return false;
    }
    if (filter.columns !== undefined) {
      for (const [key, wanted] of Object.entries(filter.columns)) {
        if (!(key in row.cells) || row.cells[key] !== wanted) return false;
      }
    }
    if (filter.provenance !== undefined && !filter.provenance.includes(row.provenance)) return false;
    return true;
  });
}

// ---- search ranking (docs/contract-additions/ops.md section 5) ---------------------------------

export const SEARCH_TYPE_ORDER = ["entity", "view", "example", "claim"] as const;
export type SearchType = (typeof SEARCH_TYPE_ORDER)[number];
export interface SearchDocument { type: SearchType; id: string; texts: string[] }

/** 0 = exact, 1 = prefix, 2 = substring, null = no match; case-insensitive; best tier across the texts. */
export function searchTier(texts: readonly string[], query: string): 0 | 1 | 2 | null {
  const q = query.toLowerCase();
  let best: 0 | 1 | 2 | null = null;
  for (const text of texts) {
    const t = text.toLowerCase();
    const tier = t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : null;
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

/** exact > prefix > substring, then type order entity,view,example,claim, then id in code-unit order. */
export function rankSearch(documents: readonly SearchDocument[], query: string): SearchDocument[] {
  const scored = documents.flatMap((document) => {
    const tier = searchTier(document.texts, query);
    return tier === null ? [] : [{ document, tier }];
  });
  scored.sort((x, y) => {
    if (x.tier !== y.tier) return x.tier - y.tier;
    const byType = SEARCH_TYPE_ORDER.indexOf(x.document.type) - SEARCH_TYPE_ORDER.indexOf(y.document.type);
    if (byType !== 0) return byType;
    return compareCodeUnits(x.document.id, y.document.id);
  });
  return scored.map((entry) => entry.document);
}

// ---- tree filtering (red-contract section 3) ----------------------------------------------------

export interface OracleTreeNode { id: string; children: string[] }
/** Matching nodes plus their ancestors; ancestors that do not match themselves are `context`. Preorder over `roots`. */
export function treeFilter(
  roots: readonly string[],
  nodes: readonly OracleTreeNode[],
  matches: (id: string) => boolean,
): { matched: string[]; context: string[]; preorder: string[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const preorder: string[] = [];
  const visit = (id: string): void => {
    preorder.push(id);
    for (const child of byId.get(id)?.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  const hasMatch = (id: string): boolean => matches(id) || (byId.get(id)?.children ?? []).some(hasMatch);
  const matched = preorder.filter(matches);
  const context = preorder.filter((id) => !matches(id) && hasMatch(id));
  return { matched, context, preorder: preorder.filter((id) => matches(id) || hasMatch(id)) };
}

// ---- cursor chains -------------------------------------------------------------------------------

/**
 * Follows `cursor` from the first page until it is null. Fails (by assertion) on a repeated cursor token
 * (a loop that makes no progress) or after `maxPages`, so a broken pager cannot hang a test.
 */
export async function followCursors<T extends { cursor: string | null }>(
  fetchPage: (cursor: string | null) => Promise<T>,
  maxPages = 400,
): Promise<T[]> {
  const pages: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    pages.push(page);
    if (page.cursor === null) return pages;
    if (seen.has(page.cursor)) assert.fail(`repeated cursor token after ${pages.length} pages: the pager makes no progress`);
    seen.add(page.cursor);
    if (pages.length >= maxPages) assert.fail(`more than ${maxPages} pages: the pager does not terminate`);
    cursor = page.cursor;
  }
}

/** A pure model pager: pages of `pageSize` items over `items`; cursor = decimal offset. Used to test followCursors itself. */
export function modelPager<T>(items: readonly T[], pageSize: number) {
  return async (cursor: string | null): Promise<{ items: T[]; cursor: string | null }> => {
    const start = cursor === null ? 0 : Number(cursor);
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize;
    return { items: slice, cursor: next < items.length ? String(next) : null };
  };
}

/** Every element of `actual` exactly once and in order equal to `expected` (reported with the first difference). */
export function describeSequenceDifference(expected: readonly string[], actual: readonly string[]): string | null {
  if (expected.length === actual.length && expected.every((value, index) => value === actual[index])) return null;
  const seen = new Set<string>();
  const duplicates = actual.filter((value) => (seen.has(value) ? true : (seen.add(value), false)));
  const firstDifference = expected.findIndex((value, index) => value !== actual[index]);
  return `expected ${expected.length} ids, got ${actual.length}; duplicates=${JSON.stringify(duplicates.slice(0, 5))}; first difference at ${firstDifference}: expected ${JSON.stringify(expected[firstDifference])}, got ${JSON.stringify(actual[firstDifference])}`;
}
