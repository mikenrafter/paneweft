// Opaque continuation cursors (design section 4: "A cursor binds snapshot, filter, ordering, and position. It cannot be reused
// against a different query."; round 2, S3: the position is an item index plus a byte offset inside that item).
//
// CLAIM(cursor-bound): a cursor carries a digest of the query it continues (tool, view, snapshot, filter, order, ...). A cursor that is
//   well formed but belongs to another query is CURSOR_MISMATCH; anything that does not decode, or whose checksum fails, is
//   CURSOR_INVALID. The budget is NOT part of the query, so a chain may change its budget between pages [operations.paging.test.ts, MC19].
// CLAIM(cursor-content-bound): a cursor over a listing also carries `c`, a digest of the listing's entries at the time it was issued; a cursor
//   whose digest differs from the listing it is presented to is CURSOR_STALE (the rows moved under it), never a silently shifted page
//   [cursor.content-binding.test.ts, review S10]. Cursors of replies that page static text (describe_component) carry no digest.
// Wire form: `1.<query 12 hex>.<content 8 hex or ->.<index>.<byte offset>.<t|j|->.<checksum 6 hex>`; the checksum is the first 6 hex characters of
// SHA-256 over "paneweft-cursor/1:" + everything before the last dot. It is an integrity check against accidents and casual edits, not a secret:
// cursors are not credentials, they only say where to continue a read-only listing. (The earlier base64url-JSON form was about 30 bytes longer; the
// content digest added in review S10 would have pushed the 2048-byte floor of open_entity over its limit.)
import { canonicalJson } from "./canonical.ts";
import { sha256Hex } from "./digest.ts";

export interface CursorPosition {
  /** index of the entry to continue at */
  index: number;
  /** UTF-8 byte offset inside that entry; 0 = start of the entry */
  offset: number;
  /** the format the offset was measured in; only present when offset > 0 (the byte offsets of the two formats differ) */
  format?: "text" | "json";
}

export type CursorDecoding =
  | { ok: true; position: CursorPosition; query: string; content?: string }
  | { ok: false; reason: "invalid" };

/** A short digest of everything that defines which listing a cursor belongs to. */
export function queryDigest(query: unknown): string {
  return sha256Hex(canonicalJson(query)).slice(0, 12);
}

const checksum = (payload: string): string => sha256Hex(`paneweft-cursor/1:${payload}`).slice(0, 6);
const WIRE = /^1\.([0-9a-f]{12})\.([0-9a-f]{8}|-)\.(\d{1,15})\.(\d{1,15})\.([tj-])\.([0-9a-f]{6})$/;

export function encodeCursor(query: string, position: CursorPosition, content?: string): string {
  const flag = position.offset > 0 && position.format !== undefined ? (position.format === "text" ? "t" : "j") : "-";
  const payload = `1.${query}.${content ?? "-"}.${position.index}.${position.offset}.${flag}`;
  return `${payload}.${checksum(payload)}`;
}

export function decodeCursor(token: string): CursorDecoding {
  const invalid: CursorDecoding = { ok: false, reason: "invalid" };
  const parts = WIRE.exec(token);
  if (parts === null) return invalid;
  const [, query, content, index, offset, flag, sum] = parts as unknown as [string, string, string, string, string, string, string];
  if (sum !== checksum(token.slice(0, token.lastIndexOf(".")))) return invalid;
  const position = { index: Number(index), offset: Number(offset) };
  if (!Number.isSafeInteger(position.index) || !Number.isSafeInteger(position.offset)) return invalid;
  const format = flag === "t" ? "text" : flag === "j" ? "json" : undefined;
  return { ok: true, query, position: { ...position, ...(format === undefined ? {} : { format }) }, ...(content === "-" ? {} : { content }) };
}
