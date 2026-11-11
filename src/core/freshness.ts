// Freshness is computed separately from completeness (design section 4).
// A complete historical view stays complete; freshness only says whether today's bytes still match.
// fresh: every recorded file hashes the same. stale: at least one differs or is gone (changedPaths).
// unknown: some root is inaccessible and nothing is known stale. stale wins over unknown.
import type { Envelope } from "./wire.ts";

export interface ChangedPath { repository: string; path: string; recordedSha256: string; currentSha256: string | null }
export type FreshnessResult =
  | { status: "fresh" }
  | { status: "stale"; changedPaths: ChangedPath[]; inaccessibleRoots: string[] }
  | { status: "unknown"; inaccessibleRoots: string[] };

/** STUB. `rootOverrides` maps repository id to a local root, replacing the envelope's recorded root. */
export async function checkFreshness(_freshness: Envelope["freshness"], _rootOverrides?: Record<string, string>): Promise<FreshnessResult> {
  return { status: "unknown", inaccessibleRoots: ["stub"] };
}
