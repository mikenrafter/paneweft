// The shared operation layer. CLI and MCP are thin adapters over executeOperation, which is
// how "CLI and MCP produce the same error codes and summary contents" (design section 5) holds
// by construction; MC11 proves it against literal bytes as well.
//
// Reason: one place owns argument validation, bounded summaries, cursors and error mapping.
// Errors: never throws; failures are `{ok:false}` outcomes carrying an OperationError.
// Invariants:
//   - `body` is the whole serialized business reply; Buffer.byteLength(body) <= maxBytes (MC3).
//   - A reply header always states question, completeness, freshness, snapshot, provenance (MC4, MC5).
//   - `args` are validated against src/schemas/tools/<name>.schema.json. maxBytes < 2048 is
//     BUDGET_TOO_SMALL (minimumBytes 2048); other argument faults are INVALID_ARGUMENT with a pointer.
// Mating parts: src/cli/main.ts, src/mcp/server.ts.
import type { OperationError } from "./errors.ts";
import { notImplemented } from "./errors.ts";
import type { Session } from "./session.ts";

export type ReplyFormat = "text" | "json";

export type OperationOutcome =
  | { ok: true; format: ReplyFormat; body: string; payload: unknown; cursor: string | null }
  | { ok: false; format: ReplyFormat; body: string; error: OperationError };

/** STUB. `name` is one of the 13 tool names (src/schemas/index.ts TOOL_NAMES). */
export async function executeOperation(_session: Session | null, name: string, args: unknown): Promise<OperationOutcome> {
  const error = notImplemented(`operation ${name}`);
  const format: ReplyFormat = (args as { format?: ReplyFormat } | null)?.format === "json" ? "json" : "text";
  return { ok: false, format, body: JSON.stringify(error), error };
}
