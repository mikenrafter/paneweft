// The rows of a stored list page, checked the same way wherever they enter or leave the session (S22): at admission, before anything is
// committed, and again by the one reader of stored pages (`readPageAt` in read.ts: view_result, the viewer, the CLI and V1Reader.page all end
// there). A page is data somebody else wrote; no reader trusts it.
import { canonicalJson } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import type { ValidationIssue } from "../core/errors.ts";
import { validateAgainstV1 } from "./schemas.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const issue = (code: ValidationIssue["code"], pointer: string, constraint: string, hint: string): ValidationIssue => ({ code, pointer, constraint, hint });

/** The ids of the rows of a list's first page that have one: the ids a later page may not repeat. */
export function rowIds(rows: unknown): string[] {
  return Array.isArray(rows) ? rows.flatMap((row) => (isRecord(row) && typeof row.id === "string" ? [row.id] : [])) : [];
}

/** Faults of `rows` as rows of the list `list` (its `columns` and `order`): each is an object the list-row schema accepts, its cells name declared
 * columns, and its id is not in `seen` (which the call extends: ids are occurrence ids, unique over every page of the view). A row's SDK-only
 * `target` is not part of the stored v0 row and is checked where the objects are known. Pointers start at `base`. */
export function checkListRows(list: { columns?: unknown; order?: unknown }, rows: unknown, base: string, seen: Set<string>): ValidationIssue[] {
  if (!Array.isArray(rows)) return [issue("TYPE", base, "type: array", "A stored page holds an array of rows.")];
  const faults: ValidationIssue[] = [];
  const bare = rows.map((row) => {
    if (!isRecord(row) || !("target" in row)) return row;
    const { target: _target, ...rest } = row;
    return rest;
  });
  for (const fault of validateAgainstV1("urn:paneweft:schema:component:list:1", { columns: list.columns, rows: bare, order: list.order })) {
    if (fault.pointer === "/rows" || fault.pointer.startsWith("/rows/")) faults.push({ ...fault, pointer: `${base}${fault.pointer.slice("/rows".length)}`, hint: "A stored row is a row of the list component its view declares." });
  }
  const columns = new Set(Array.isArray(list.columns) ? list.columns.flatMap((column) => (isRecord(column) && typeof column.key === "string" ? [column.key] : [])) : []);
  rows.forEach((row, index) => {
    if (!isRecord(row)) return;
    if (typeof row.id === "string") {
      if (seen.has(row.id)) faults.push(issue("DUPLICATE_ID", `${base}/${index}/id`, "row ids are unique over every page of the view", `The id "${row.id}" is already used by another row of this view.`));
      seen.add(row.id);
    }
    if (isRecord(row.cells)) for (const key of Object.keys(row.cells)) if (!columns.has(key)) faults.push(issue("CONSTRAINT", `${base}/${index}/cells/${key}`, "a cell names a column the view declares", `The view declares the columns ${[...columns].join(", ") || "(none)"}.`));
  });
  return faults;
}

/** The content address of the rows of a stored page: the sha256 of their canonical JSON. */
export const pageIdOf = (rows: unknown): string => `sha256:${sha256Hex(canonicalJson(rows))}`;
