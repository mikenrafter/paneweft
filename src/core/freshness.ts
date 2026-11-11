// Freshness is computed separately from completeness (design section 4).
// A complete historical view stays complete; freshness only says whether today's bytes still match.
//
// S1 (round 2): bytes are read ONLY under repository roots the operator registered (session config /
// `serve` flags). A root recorded inside a submitted envelope never authorises filesystem access: such a
// repository is `unverified` with a reason and nothing is read, probed or hashed for it.
// fresh: every repository is registered and every recorded file hashes the same.
// stale: at least one differs or is gone (changedPaths). unknown: a registered root is inaccessible and
// nothing is known stale. unverified: some repository is not registered (and nothing is stale or unknown).
// Precedence stale > unknown > unverified > fresh; `unverified` lists are attached whenever non-empty.
import type { Envelope } from "./wire.ts";
import type { RepositoryRegistration } from "./session.ts";

export interface ChangedPath { repository: string; path: string; recordedSha256: string; currentSha256: string | null }
/** A repository whose freshness was not checked. `code` is machine readable, `reason` is for people. */
export interface UnverifiedRepository { repository: string; code: "REPOSITORY_NOT_REGISTERED"; reason: string }
export type FreshnessResult =
  | { status: "fresh" }
  | { status: "stale"; changedPaths: ChangedPath[]; inaccessibleRoots: string[]; unverified?: UnverifiedRepository[] }
  | { status: "unknown"; inaccessibleRoots: string[]; unverified?: UnverifiedRepository[] }
  | { status: "unverified"; unverified: UnverifiedRepository[] };

/** STUB. `registered` is the operator's registry (`Session.repositories()`); the envelope's recorded `root` is ignored. */
export async function checkFreshness(_freshness: Envelope["freshness"], _registered: RepositoryRegistration[]): Promise<FreshnessResult> {
  return { status: "unknown", inaccessibleRoots: ["stub"] };
}
