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
//
// CLAIM(no-read-before-deny): the registration check happens BEFORE any filesystem call for a repository, and a recorded path is
//   judged lexically before it is touched, so nothing outside a registered root is read, stat'ed, listed or resolved
//   [freshness.test.ts N3, observed with test/helpers/fs-spy.ts].
import { stat } from "node:fs/promises";
import type { Envelope } from "./wire.ts";
import type { RepositoryRegistration } from "./session.ts";
import { normaliseRelativePath } from "./anchors.ts";
import { readConfinedFile } from "./confined-read.ts";
import { compareCodeUnits } from "./canonical.ts";
import { sha256Hex } from "./digest.ts";

export interface ChangedPath { repository: string; path: string; recordedSha256: string; currentSha256: string | null }
/** A repository whose freshness was not checked. `code` is machine readable, `reason` is for people. */
export interface UnverifiedRepository { repository: string; code: "REPOSITORY_NOT_REGISTERED"; reason: string }
export type FreshnessResult =
  | { status: "fresh" }
  | { status: "stale"; changedPaths: ChangedPath[]; inaccessibleRoots: string[]; unverified?: UnverifiedRepository[] }
  | { status: "unknown"; inaccessibleRoots: string[]; unverified?: UnverifiedRepository[] }
  | { status: "unverified"; unverified: UnverifiedRepository[] };

/** Where a registered root's file stands now. `sha256: null` means the file is gone, unreadable or unreachable from the root. */
export type CurrentFile = { state: "unregistered" } | { state: "root-inaccessible"; root: string } | { state: "present"; sha256: string | null };

/** The sha256 of `path` under the operator-registered root of `repository`, judged lexically first and canonically second. */
export async function currentFileHash(registered: RepositoryRegistration[], repository: string, path: string): Promise<CurrentFile> {
  const registration = registered.find((candidate) => candidate.id === repository);
  if (registration === undefined) return { state: "unregistered" };
  try {
    if (!(await stat(registration.root)).isDirectory()) return { state: "root-inaccessible", root: registration.root };
  } catch {
    return { state: "root-inaccessible", root: registration.root };
  }
  const relative = normaliseRelativePath(path);
  if (relative === null) return { state: "present", sha256: null };
  const read = await readConfinedFile(registration.root, relative);
  if (!read.ok) return read.reason === "root-inaccessible" ? { state: "root-inaccessible", root: registration.root } : { state: "present", sha256: null };
  return { state: "present", sha256: sha256Hex(read.bytes) };
}

export async function checkFreshness(freshness: Envelope["freshness"], registered: RepositoryRegistration[]): Promise<FreshnessResult> {
  const changedPaths: ChangedPath[] = [];
  const inaccessibleRoots: string[] = [];
  const unverified: UnverifiedRepository[] = [];
  for (const record of freshness.repositories) {
    if (!registered.some((registration) => registration.id === record.id)) {
      unverified.push({
        repository: record.id,
        code: "REPOSITORY_NOT_REGISTERED",
        reason: `repository "${record.id}" is not registered with this session, so its files were not checked; register its root to verify freshness`,
      });
      continue; // CLAIM(no-read-before-deny): nothing below runs for this repository
    }
    for (const path of Object.keys(record.files).sort(compareCodeUnits)) {
      const recordedSha256 = record.files[path] as string;
      const current = await currentFileHash(registered, record.id, path);
      if (current.state === "root-inaccessible") {
        if (!inaccessibleRoots.includes(current.root)) inaccessibleRoots.push(current.root);
        break; // the root cannot be read at all; one report per root, not one per file
      }
      const currentSha256 = current.state === "present" ? current.sha256 : null;
      if (currentSha256 !== recordedSha256) changedPaths.push({ repository: record.id, path, recordedSha256, currentSha256 });
    }
    // a registered repository with no recorded files still needs an accessible root to count as checked
    if (Object.keys(record.files).length === 0) {
      const root = (registered.find((registration) => registration.id === record.id) as RepositoryRegistration).root;
      try {
        if (!(await stat(root)).isDirectory()) inaccessibleRoots.push(root);
      } catch {
        inaccessibleRoots.push(root);
      }
    }
  }
  const extra = unverified.length > 0 ? { unverified } : {};
  if (changedPaths.length > 0) return { status: "stale", changedPaths, inaccessibleRoots, ...extra };
  if (inaccessibleRoots.length > 0) return { status: "unknown", inaccessibleRoots, ...extra };
  if (unverified.length > 0) return { status: "unverified", unverified };
  return { status: "fresh" };
}
