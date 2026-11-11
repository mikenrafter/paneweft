// Opaque continuation cursors (design section 4: "A cursor binds snapshot, filter, ordering, and position. It cannot be reused
// against a different query."; round 2, S3: the position is an item index plus a byte offset inside that item).
//
// CLAIM(cursor-bound): a cursor carries a digest of the query it continues (tool, view, snapshot, filter, order, ...). A cursor that is
//   well formed but belongs to another query is CURSOR_MISMATCH; anything that does not decode, or whose checksum fails, is
//   CURSOR_INVALID. The budget is NOT part of the query, so a chain may change its budget between pages [operations.paging.test.ts, MC19].
// Wire form: base64url(JSON {v, q, i, b[, f]}) + "." + 6 hex characters of a SHA-256 checksum. The checksum is an integrity check against
// accidents and casual edits, not a secret: cursors are not credentials, they only say where to continue a read-only listing.
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
  | { ok: true; position: CursorPosition; query: string }
  | { ok: false; reason: "invalid" };

/** A short digest of everything that defines which listing a cursor belongs to. */
export function queryDigest(query: unknown): string {
  return sha256Hex(canonicalJson(query)).slice(0, 12);
}

const checksum = (payload: string): string => sha256Hex(`paneweft-cursor/1:${payload}`).slice(0, 6);

export function encodeCursor(query: string, position: CursorPosition): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, q: query, i: position.index, b: position.offset, ...(position.offset > 0 && position.format !== undefined ? { f: position.format } : {}) }), "utf8").toString("base64url");
  return `${payload}.${checksum(payload)}`;
}

export function decodeCursor(token: string): CursorDecoding {
  const invalid: CursorDecoding = { ok: false, reason: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2) return invalid;
  const [payload, sum] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || sum !== checksum(payload)) return invalid;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.q !== "string" || !Number.isSafeInteger(value.i) || !Number.isSafeInteger(value.b) || (value.i as number) < 0 || (value.b as number) < 0) return invalid;
    const format = value.f === "text" || value.f === "json" ? value.f : undefined;
    return { ok: true, query: value.q, position: { index: value.i as number, offset: value.b as number, ...(format === undefined ? {} : { format }) } };
  } catch {
    return invalid;
  }
}
