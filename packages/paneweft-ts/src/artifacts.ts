// The artifact protocol between a test worker and the host collector (docs/v1-red-contract.md section 7).
// A suite run without a collector still executes assertions; it neither starts a server nor creates a global session.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyLimitOverrides, defaultLimits } from "./limits.ts";
import type { Json, Limits } from "./types.ts";

export const ENV = { collect: "PANEWEFT_COLLECT", runId: "PANEWEFT_RUN_ID", stagingDir: "PANEWEFT_STAGING_DIR", attempt: "PANEWEFT_ATTEMPT", catalogue: "PANEWEFT_CATALOGUE", limits: "PANEWEFT_LIMITS" } as const;

export interface Staging {
  runId: string;
  dir: string;
  attempt: number;
}

/** Reads the collector's environment. `null` when collection is not enabled. */
export function stagingFromEnv(env: Record<string, string | undefined> = process.env): Staging | null {
  if (env[ENV.collect] !== "1") return null;
  const runId = env[ENV.runId];
  const dir = env[ENV.stagingDir];
  if (runId === undefined || runId === "" || dir === undefined || dir === "") return null;
  const attempt = Number(env[ENV.attempt]);
  return { runId, dir, attempt: Number.isInteger(attempt) && attempt >= 1 ? attempt : 1 };
}

/** The limits this process captures under: the defaults, lowered by PANEWEFT_LIMITS when the collector set it. */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): Limits {
  const text = env[ENV.limits];
  if (text === undefined) return defaultLimits();
  try {
    return applyLimitOverrides(defaultLimits(), JSON.parse(text) as Partial<Limits>);
  } catch {
    return defaultLimits();
  }
}

/** Writes through a temporary sibling and a rename, so a reader never sees half a document. A failed write is reported on stderr
 * and never masks a test result; the host counts the missing record. */
export function writeArtifact(path: string, value: Json | Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, path);
  } catch (error) {
    process.stderr.write(`paneweft: could not write ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
