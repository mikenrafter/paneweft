// The agent tools (spec section 6, MCP and CLI contract) as shared handlers. CLI and MCP are thin adapters over this.
import { err } from "../core/errors.ts";
import type { OperationOutcome } from "../core/operations.ts";
import type { Session } from "../core/session.ts";
import type { JobService } from "./jobs.ts";
import { NOT_IMPLEMENTED } from "./stub.ts";

export interface V1Context {
  session: Session | null;
  /** The session directory: adapters.json, catalogues/, jobs/ and renderers.trust.json live here. */
  sessionDir: string | null;
  jobs: JobService | null;
}

/** The advertised descriptors (name, description, dereferenced input schema) of the ten v1 tools. STUB: []. */
export function v1ToolDescriptors(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [];
}

/** Never throws; failures are outcomes. Operation order as v0: unknown tool, SESSION_REQUIRED, argument validation, target lookup,
 * budget. STUB: every call answers INTERNAL NOT_IMPLEMENTED. */
export async function executeV1Operation(context: V1Context, name: string, args: unknown): Promise<OperationOutcome> {
  const failure = err("INTERNAL", `${NOT_IMPLEMENTED}: ${name}`);
  if (failure.ok) throw new Error("unreachable");
  return { ok: false, format: "text", body: JSON.stringify(failure.error), error: failure.error };
}
