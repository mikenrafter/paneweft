// Test environment for the operation layer (tag: ops): a REAL Session in a temp dir, a never-throwing
// call wrapper, reply parsers and raw-Ajv validation of reply and error bodies.
// No expectations are computed here from src/ tables; only structure is checked.
import { afterEach, assert, expect } from "vitest";
import { executeOperation, type OperationOutcome } from "../../src/core/operations.ts";
import { openSession, type Session } from "../../src/core/session.ts";
import { createSchemaRegistry } from "../../src/schemas/index.ts";
import { followCursors, isWellFormedUtf8Text } from "./ops-oracle.ts";
import { must } from "./must.ts";
import { useTempDirs } from "./tmp.ts";

export type Json = any;

export interface OpsEnv {
  session: Session;
  dir: string;
  call(tool: string, args: unknown): Promise<OperationOutcome>;
}

/** Call once per test file. The returned opener makes a fresh session (and imports `bundle` when given). */
export function useOps(): (bundle?: unknown) => Promise<OpsEnv> {
  const tempDir = useTempDirs();
  const sessions: Session[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close().catch(() => {});
  });
  return async (bundle) => {
    const dir = tempDir("session");
    const session = must(await openSession(dir), "openSession");
    sessions.push(session);
    if (bundle !== undefined) must(await session.importBundle(bundle), "importBundle");
    return { session, dir, call: (tool, args) => callOperation(session, tool, args) };
  };
}

/** executeOperation never throws by contract; a throw becomes a failing assertion instead of a stack trace. */
export async function callOperation(session: Session | null, tool: string, args: unknown): Promise<OperationOutcome> {
  try {
    return await executeOperation(session, tool, args);
  } catch (error) {
    return assert.fail(`executeOperation(${tool}) threw instead of returning an outcome: ${String(error)}`);
  }
}

let registry: ReturnType<typeof createSchemaRegistry> | undefined;
function schemas() {
  registry ??= createSchemaRegistry();
  return registry;
}
export function validateAgainst(schemaId: string, value: unknown): string[] {
  const validate = schemas().getSchema(schemaId);
  if (validate === undefined) return [`schema ${schemaId} is not registered`];
  return validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
/** The continuation cursor of an ok outcome; null for errors. */
export function cursorOf(outcome: OperationOutcome): string | null {
  return outcome.ok ? outcome.cursor : null;
}
export const REPLY_SCHEMA = "urn:paneweft:schema:reply:1";
export const ERROR_SCHEMA = "urn:paneweft:schema:error:1";

export function assertBodyWithin(body: string, maxBytes: number, context = "reply"): void {
  const bytes = Buffer.byteLength(body, "utf8");
  expect(bytes, `${context}: ${bytes} bytes against a budget of ${maxBytes}`).toBeLessThanOrEqual(maxBytes);
  expect(isWellFormedUtf8Text(body), `${context}: body is not well-formed UTF-8 text (U+FFFD or lone surrogate)`).toBe(true);
}

/** Asserts an `ok:true` JSON reply that validates against reply.schema.json; returns the parsed body. */
export function okJson(outcome: OperationOutcome, options: { schema?: boolean } = {}): Json {
  if (!outcome.ok) assert.fail(`expected ok:true, got ${outcome.error.code}: ${outcome.error.message} ${JSON.stringify(outcome.error.errors)}`);
  expect(outcome.format).toBe("json");
  let parsed: Json;
  try {
    parsed = JSON.parse(outcome.body);
  } catch (error) {
    return assert.fail(`body is not JSON (${String(error)}): ${outcome.body.slice(0, 200)}`);
  }
  if (options.schema !== false) expect(validateAgainst(REPLY_SCHEMA, parsed), "reply.schema.json").toEqual([]);
  expect(outcome.payload, "payload is the parsed JSON reply").toEqual(parsed);
  expect(parsed.cursor, "body cursor equals outcome cursor").toBe(outcome.cursor);
  return parsed;
}

/** Asserts an `ok:false` outcome whose body is a valid paneweft.error/1 document equal to `outcome.error`. */
export function failure(outcome: OperationOutcome) {
  if (outcome.ok) assert.fail(`expected an error, got ok:true body=${outcome.body.slice(0, 300)}`);
  let parsed: Json;
  try {
    parsed = JSON.parse(outcome.body);
  } catch (error) {
    return assert.fail(`error body is not JSON (${String(error)}): ${outcome.body.slice(0, 200)}`);
  }
  expect(validateAgainst(ERROR_SCHEMA, parsed), "error.schema.json").toEqual([]);
  expect(parsed, "error body equals outcome.error").toEqual(outcome.error);
  return outcome.error;
}

/** code plus the exact (pointer, issue code) list of an error. */
export function issuesOf(outcome: OperationOutcome): { code: string; issues: Array<[string, string]> } {
  const error = failure(outcome);
  return { code: error.code, issues: error.errors.map((issue): [string, string] => [issue.pointer, issue.code]) };
}

// ---- text replies ---------------------------------------------------------------------------------

export const HEADER_KEYS = ["question", "snapshot", "completeness", "freshness", "provenance", "evidence", "filters", "order", "counts"] as const;
export interface TextReply {
  raw: string;
  firstLine: string;
  view: string;
  component: string;
  /** header value by key (the part after "key: "). */
  header: Record<(typeof HEADER_KEYS)[number], string>;
  counts: { unit: string; total: number; matched: number; returned: number; omitted: number; truncated: boolean };
  /** Lines after the counts line, without the final `cursor:` line. */
  body: string[];
  cursor: string | null;
}

/** Parses the red-contract section 3 text form; fails by assertion when the mandatory header is not exactly that shape. */
export function parseTextReply(raw: string): TextReply {
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const firstLine = lines[0] ?? "";
  const first = /^paneweft\.reply\/1 view=(\S+) component=(\S+)$/.exec(firstLine);
  if (first === null) assert.fail(`first line is not "paneweft.reply/1 view=<id> component=<c>": ${JSON.stringify(firstLine)}`);
  const header: Partial<Record<(typeof HEADER_KEYS)[number], string>> = {};
  HEADER_KEYS.forEach((key, index) => {
    const line = lines[index + 1] ?? "";
    const prefix = `${key}: `;
    if (!line.startsWith(prefix)) assert.fail(`header line ${index + 2} must start with "${prefix}" (contract order), got ${JSON.stringify(line.slice(0, 120))}`);
    header[key] = line.slice(prefix.length);
  });
  const rest = lines.slice(HEADER_KEYS.length + 1);
  const completenessLines = lines.slice(0, HEADER_KEYS.length + 1).filter((line) => line.startsWith("completeness:"));
  expect(completenessLines, "exactly one completeness: line in the header").toHaveLength(1);
  const countsMatch = /^unit=(\S+) total=(\d+) matched=(\d+) returned=(\d+) omitted=(\d+) truncated=(true|false)$/.exec(header.counts ?? "");
  if (countsMatch === null) assert.fail(`counts line malformed: ${JSON.stringify(header.counts)}`);
  let cursor: string | null = null;
  const last = rest[rest.length - 1];
  if (last !== undefined && last.startsWith("cursor: ")) {
    cursor = last.slice("cursor: ".length);
    rest.pop();
  }
  return {
    raw,
    firstLine,
    view: first[1] as string,
    component: first[2] as string,
    header: header as TextReply["header"],
    counts: {
      unit: countsMatch[1] as string,
      total: Number(countsMatch[2]),
      matched: Number(countsMatch[3]),
      returned: Number(countsMatch[4]),
      omitted: Number(countsMatch[5]),
      truncated: countsMatch[6] === "true",
    },
    body: rest,
    cursor,
  };
}

/** Asserts an `ok:true` text reply, checks the cursor agrees with outcome.cursor, and parses it. */
export function okText(outcome: OperationOutcome): TextReply {
  if (!outcome.ok) assert.fail(`expected ok:true, got ${outcome.error.code}: ${outcome.error.message} ${JSON.stringify(outcome.error.errors)}`);
  expect(outcome.format).toBe("text");
  const reply = parseTextReply(outcome.body);
  expect(reply.cursor, "text cursor line equals outcome.cursor").toBe(outcome.cursor);
  return reply;
}

// ---- paging ---------------------------------------------------------------------------------------

export interface JsonPage { outcome: OperationOutcome; reply: Json; cursor: string | null }
export interface TextPage { outcome: OperationOutcome; reply: TextReply; cursor: string | null }

/** Follows an inspect_view-style query to the end in JSON, asserting every page is within the budget. */
export async function jsonPages(env: OpsEnv, tool: string, args: Record<string, unknown>, maxBytes: number, maxPages = 400): Promise<JsonPage[]> {
  return followCursors<JsonPage>(async (cursor) => {
    const outcome = await env.call(tool, { ...args, format: "json", maxBytes, ...(cursor === null ? {} : { cursor }) });
    const reply = okJson(outcome);
    assertBodyWithin(outcome.body, maxBytes, `${tool} page`);
    return { outcome, reply, cursor: cursorOf(outcome) };
  }, maxPages);
}
export async function textPages(env: OpsEnv, tool: string, args: Record<string, unknown>, maxBytes: number, maxPages = 400): Promise<TextPage[]> {
  return followCursors<TextPage>(async (cursor) => {
    const outcome = await env.call(tool, { ...args, format: "text", maxBytes, ...(cursor === null ? {} : { cursor }) });
    const reply = okText(outcome);
    assertBodyWithin(outcome.body, maxBytes, `${tool} page`);
    return { outcome, reply, cursor: cursorOf(outcome) };
  }, maxPages);
}

/** Entity ids of list-row body lines `<first cell> -> <kind>:<id>; <provenance>; <evidence>` (red-contract section 3). */
export function entityIdsOfLines(lines: readonly string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    const match = /^(.*) -> [a-z][a-z0-9_/.-]*:(\S+); [a-z]+; .+$/.exec(line);
    if (match !== null) ids.push(match[2] as string);
  }
  return ids;
}

export interface PageCounts { total: number; matched: number; returned: number; omitted: number }

// ---- fragments (S3) -------------------------------------------------------------------------------
/** One slice of an item too large for a page (docs/contract-additions/round2.md S3). */
export interface FragmentPiece { item_id: string; offset: number; length: number; total: number; text: string }

/** The `{fragment:{...}}` entries of a JSON page, in page order. Asserts nothing about them beyond their shape key. */
export function fragmentsOfJson(reply: Json): FragmentPiece[] {
  return (reply.items as Json[]).filter((item) => item !== null && typeof item === "object" && "fragment" in item).map((item) => item.fragment as FragmentPiece);
}
/** The stored items of a JSON page (everything that is not a fragment entry), in page order. */
export function plainItemsOfJson(reply: Json): Json[] {
  return (reply.items as Json[]).filter((item) => !(item !== null && typeof item === "object" && "fragment" in item));
}
const TEXT_FRAGMENT = /^\[fragment item=(\S+) offset=(\d+) length=(\d+) total=(\d+)\] (.*)$/;
/** Fragment lines of a text body: `[fragment item=<id> offset=<o> length=<l> total=<t>] <payload>`. */
export function fragmentsOfText(body: readonly string[]): FragmentPiece[] {
  const pieces: FragmentPiece[] = [];
  for (const line of body) {
    const match = TEXT_FRAGMENT.exec(line);
    if (match !== null) pieces.push({ item_id: match[1] as string, offset: Number(match[2]), length: Number(match[3]), total: Number(match[4]), text: match[5] as string });
  }
  return pieces;
}
/** True when the last fragment on the page leaves the rest of its item for a later page. */
export function pendingAfter(pieces: readonly FragmentPiece[]): boolean {
  const last = pieces[pieces.length - 1];
  return last !== undefined && last.offset + last.length < last.total;
}
/**
 * Reassembles fragments of ONE chain (page order). Asserts the S3 invariants per item: the first piece starts at offset 0, each next piece
 * starts where the previous ended, `length` is the UTF-8 length of `text`, `total` never changes, and the last piece ends exactly at `total`.
 * Returns item_id -> reconstructed text (and the order in which items first appeared).
 */
export function reassemble(pieces: readonly FragmentPiece[]): { order: string[]; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const totals = new Map<string, number>();
  const next = new Map<string, number>();
  const order: string[] = [];
  for (const piece of pieces) {
    const where = `fragment ${piece.item_id}@${piece.offset}`;
    if (!texts.has(piece.item_id)) { order.push(piece.item_id); texts.set(piece.item_id, ""); totals.set(piece.item_id, piece.total); next.set(piece.item_id, 0); }
    expect(piece.offset, `${where}: starts where the previous piece ended`).toBe(next.get(piece.item_id));
    expect(piece.length, `${where}: length is the UTF-8 length of text`).toBe(Buffer.byteLength(piece.text, "utf8"));
    expect(piece.length, `${where}: a piece carries at least one byte`).toBeGreaterThan(0);
    expect(piece.total, `${where}: total is stable`).toBe(totals.get(piece.item_id));
    expect(isWellFormedUtf8Text(piece.text), `${where}: text is whole code points`).toBe(true);
    texts.set(piece.item_id, (texts.get(piece.item_id) ?? "") + piece.text);
    next.set(piece.item_id, piece.offset + piece.length);
  }
  for (const [id, end] of next) expect(end, `item ${id}: the last piece ends at total (nothing silently dropped)`).toBe(totals.get(id));
  return { order, texts };
}
/**
 * docs/contract-additions/ops.md section 2: along one cursor chain `total` and `matched` are constant,
 * `offset + returned + omitted = matched` where offset = items started on earlier pages, `omitted` is what FOLLOWS
 * this page, the cursor is null exactly when nothing remains (`omitted = 0` and no pending fragment, S3), and the pages together
 * return `matched` items.
 */
export function assertChainCounts(pages: ReadonlyArray<{ counts: PageCounts; cursor: string | null; pending?: boolean }>, expected: { total: number; matched: number }): void {
  let offset = 0;
  pages.forEach((page, index) => {
    const where = `page ${index + 1}/${pages.length}`;
    expect(page.counts.total, `${where}: total`).toBe(expected.total);
    expect(page.counts.matched, `${where}: matched`).toBe(expected.matched);
    expect(offset + page.counts.returned + page.counts.omitted, `${where}: offset+returned+omitted`).toBe(expected.matched);
    // S3: `returned` counts the items whose FIRST byte is on this page, `omitted` those that start later; a cursor is null exactly when
    // nothing is left to deliver, which includes the rest of a fragmented item (`pending`).
    expect(page.cursor === null, `${where}: cursor is null iff omitted = 0 and no fragmented item is pending`).toBe(page.counts.omitted === 0 && page.pending !== true);
    offset += page.counts.returned;
  });
  expect(offset, "pages together return every matched item").toBe(expected.matched);
}
