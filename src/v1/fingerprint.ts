// Input fingerprints and freshness (spec section 6; amendments S10, N5; IV18).
import type { Result } from "../core/errors.ts";
import { notImplemented } from "./stub.ts";

export interface FingerprintOptions {
  /** The crate or package root. */
  root: string;
  /** Extra inputs outside the root (lockfiles, fixtures), relative to the root's repository or absolute inside it. */
  declaredExtras?: string[];
  /** Explicit exclusions (relative paths or directory prefixes) applied to tracked and untracked members alike. */
  exclusions?: string[];
}

export interface Fingerprint {
  /** sha256 over the sorted (path, sha256) member list. */
  digest: string;
  members: Array<{ path: string; sha256: string }>;
  declaredExtras: string[];
  exclusions: string[];
}

export type FileChange = { path: string; change: "modified" | "added" | "deleted" };

/** Members = `git ls-files` under the root + `git ls-files --others --exclude-standard` (N5) + declared extras - exclusions. STUB. */
export function computeFingerprint(options: FingerprintOptions): Promise<Result<Fingerprint>> {
  return Promise.resolve(notImplemented("computeFingerprint"));
}

/** Before/after hashing is a SAMPLE: it detects a file that differs at the two sample points, not an edit that was made and
 * restored in between (S10). The wording of `note` says so. STUB. */
export function sampleConsistency(before: Fingerprint, after: Fingerprint): { status: "consistent-sampled" | "mixed-input"; changed: FileChange[]; note: string } {
  return { status: "mixed-input", changed: [], note: "" };
}

/** Freshness of a captured fingerprint against the current one. STUB. */
export function compareFingerprints(captured: Fingerprint, current: Fingerprint): { status: "fresh" | "stale"; reasons: FileChange[] } {
  return { status: "stale", reasons: [] };
}
