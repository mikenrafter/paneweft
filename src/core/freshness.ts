// Freshness is computed separately from completeness (design section 4).
// A complete historical view stays complete; freshness only says whether today's bytes still match.
//
// S1 (round 2): bytes are read ONLY under repository roots the operator registered (session config /
// `serve` flags). A root recorded inside a submitted envelope never authorises filesystem access: such a
// repository is `unverified` with a reason and nothing is read, probed or hashed for it.
// fresh: every repository is registered and every recorded file hashes the same.
// stale: at least one differs or is gone (changedPaths). unknown: a registered root is inaccessible, or a recorded file is over the
// 16 MiB confined-read cap and was not hashed (an `unverified` entry with code FILE_TOO_LARGE names it), and nothing is known stale. unverified: some repository is not registered, or its files cannot be read on this platform
// (UNSUPPORTED_PLATFORM, confined reads are Linux-only), and nothing is stale or unknown.
// Precedence stale > unknown > unverified > fresh; `unverified` lists are attached whenever non-empty.
//
// CLAIM(no-read-before-deny): the registration check happens BEFORE any filesystem call for a repository, and a recorded path is
//   judged lexically before it is touched, so nothing outside a registered root is read, stat'ed, listed or resolved
//   [freshness.test.ts N3, observed with test/helpers/fs-spy.ts].
import { stat } from "node:fs/promises";
import type { Envelope } from "./wire.ts";
import type { RepositoryRegistration } from "./session.ts";
import { normaliseRelativePath } from "./anchors.ts";
import { hashConfinedFile, MAX_CONFINED_FILE_BYTES, UNSUPPORTED_PLATFORM_MESSAGE } from "./confined-read.ts";
import { compareCodeUnits } from "./canonical.ts";

/** A recorded file that no longer matches. `recordedSha256` is null for a file that was not there when the result was recorded; `change` is set by
 * sources that compare whole file sets (a collected run's input fingerprint can see an added file, an anchor check cannot). */
export interface ChangedPath { repository: string; path: string; recordedSha256: string | null; currentSha256: string | null; change?: "added" | "modified" | "deleted" }
/** A repository whose freshness was not checked. `code` is machine readable, `reason` is for people. */
export interface UnverifiedRepository {
  repository: string;
  code: "REPOSITORY_NOT_REGISTERED" | "UNSUPPORTED_PLATFORM" | "FILE_TOO_LARGE" | "FINGERPRINT_UNAVAILABLE" | "INPUT_UNSTABLE";
  reason: string;
  /** FILE_TOO_LARGE only: the recorded files that were not hashed (the first 20, code-unit order). */
  paths?: string[];
}
export type FreshnessResult =
  | { status: "fresh" }
  | { status: "stale"; changedPaths: ChangedPath[]; inaccessibleRoots: string[]; unverified?: UnverifiedRepository[] }
  | { status: "unknown"; inaccessibleRoots: string[]; unverified?: UnverifiedRepository[] }
  | { status: "unverified"; unverified: UnverifiedRepository[] };

/** Where a registered root's file stands now. `sha256: null` means the file is gone, unreadable or unreachable from the root. */
export type CurrentFile = { state: "unregistered" } | { state: "unsupported-platform" } | { state: "root-inaccessible"; root: string } | { state: "too-large" } | { state: "present"; sha256: string | null };

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
  const hashed = await hashConfinedFile(registration.root, relative);
  if (!hashed.ok) {
    if (hashed.reason === "unsupported-platform") return { state: "unsupported-platform" };
    if (hashed.reason === "too-large") return { state: "too-large" };
    return hashed.reason === "root-inaccessible" ? { state: "root-inaccessible", root: registration.root } : { state: "present", sha256: null };
  }
  return { state: "present", sha256: hashed.sha256 };
}

export async function checkFreshness(freshness: Envelope["freshness"], registered: RepositoryRegistration[]): Promise<FreshnessResult> {
  const changedPaths: ChangedPath[] = [];
  const inaccessibleRoots: string[] = [];
  const unverified: UnverifiedRepository[] = [];
  let tooLargeSeen = false;
  for (const record of freshness.repositories) {
    if (!registered.some((registration) => registration.id === record.id)) {
      unverified.push({
        repository: record.id,
        code: "REPOSITORY_NOT_REGISTERED",
        reason: `repository "${record.id}" is not registered with this session, so its files were not checked; register its root to verify freshness`,
      });
      continue; // CLAIM(no-read-before-deny): nothing below runs for this repository
    }
    const tooLarge: string[] = [];
    for (const path of Object.keys(record.files).sort(compareCodeUnits)) {
      const recordedSha256 = record.files[path] as string;
      const current = await currentFileHash(registered, record.id, path);
      if (current.state === "unsupported-platform") {
        unverified.push({ repository: record.id, code: "UNSUPPORTED_PLATFORM", reason: `repository "${record.id}" was not checked: ${UNSUPPORTED_PLATFORM_MESSAGE}` });
        break; // no file of this repository can be read here; one report per repository
      }
      if (current.state === "root-inaccessible") {
        if (!inaccessibleRoots.includes(current.root)) inaccessibleRoots.push(current.root);
        break; // the root cannot be read at all; one report per root, not one per file
      }
      if (current.state === "too-large") { tooLarge.push(path); continue; } // not hashed: neither fresh nor stale
      const currentSha256 = current.state === "present" ? current.sha256 : null;
      if (currentSha256 !== recordedSha256) changedPaths.push({ repository: record.id, path, recordedSha256, currentSha256 });
    }
    if (tooLarge.length > 0) {
      tooLargeSeen = true;
      const shown = tooLarge.slice(0, 5).join(", ");
      unverified.push({ repository: record.id, code: "FILE_TOO_LARGE", paths: tooLarge.slice(0, 20), reason: `repository "${record.id}": ${tooLarge.length} recorded file${tooLarge.length === 1 ? " is" : "s are"} over ${MAX_CONFINED_FILE_BYTES} bytes and not hashed, so ${tooLarge.length === 1 ? "its" : "their"} freshness is unknown: ${shown}${tooLarge.length > 5 ? ` (+${tooLarge.length - 5} more)` : ""}` });
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
  if (inaccessibleRoots.length > 0 || tooLargeSeen) return { status: "unknown", inaccessibleRoots, ...extra };
  if (unverified.length > 0) return { status: "unverified", unverified };
  return { status: "fresh" };
}
