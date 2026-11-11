// The one place that reads a file under a root the operator registered (review S1). Used by source anchors, freshness hashing and
// the viewer's static files, so the confinement rule exists once.
//
// Why it exists: checking a canonical path and then reading by PATHNAME leaves a window in which a file, or any ancestor directory,
// can be swapped for a symlink that leaves the root (check-to-use race). Reading by path is therefore never done here.
// CLAIM(confined-read): bytes are returned only from a file handle whose own real path lies inside the real root, and are read from
//   that handle, never from a pathname; so a swap after the check either fails the open or is caught by the handle check
//   [design section 5; confined-read.test.ts S1].
// How, in order:
//   1. realpath of the root and of the target (lexical judgement is the caller's, see normaliseRelativePath);
//   2. open the canonical path with O_NOFOLLOW (a leaf swapped for a symlink fails with ELOOP, and the resolution is retried so a
//      swap to a VALID internal link is followed through the new canonical answer) and O_NONBLOCK (a FIFO cannot hang the open);
//   3. ask the kernel where the OPEN handle lives (`realpath /proc/self/fd/<fd>`), which also catches a swapped ancestor directory,
//      something O_NOFOLLOW on the leaf cannot see; refuse if that is outside the root or not a regular file;
//   4. read from the handle.
// Platform: step 3 needs Linux's /proc/self/fd. v0 confined reads are Linux-only (review round 2, S1): anywhere else, or when /proc cannot
// be used, nothing is opened and the read fails closed with `unsupported-platform`. A weaker fallback (device/inode against a re-resolved
// pathname) was removed because it leaves the check-to-use window open, which this module exists to close.
// Errors: returns a reason, never throws and never echoes file content or the outside path:
//   root-inaccessible (root cannot be resolved), not-found (missing, unreadable, or not a regular file), outside (leaves the root),
//   unsupported-platform (no /proc/self/fd: the read is refused rather than weakened).
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

export type ConfinedReason = "root-inaccessible" | "not-found" | "outside" | "unsupported-platform";
export type CanonicalPath = { ok: true; path: string; root: string } | { ok: false; reason: ConfinedReason };
export type ConfinedRead = { ok: true; bytes: Buffer; realPath: string } | { ok: false; reason: ConfinedReason };

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** A swapped leaf is resolved again this many times before the read fails closed. */
const MAX_ATTEMPTS = 3;

let platformOverride: string | undefined;
/** Test seam: judge the platform as `platform` until the returned function restores the real one. Never used outside tests. */
export function pretendPlatform(platform: string): () => void {
  platformOverride = platform;
  return () => { platformOverride = undefined; };
}
const currentPlatform = (): string => platformOverride ?? process.platform;
/** Whether confined reads can be vouched for here (Linux: the handle's own path comes from /proc/self/fd). */
export const confinedReadsSupported = (): boolean => currentPlatform() === "linux";

/** The one wording for "this platform cannot confine a read", shared by the anchor error and the freshness reason. */
export const UNSUPPORTED_PLATFORM_MESSAGE = "reads confined to a registered root need Linux (/proc/self/fd); on this platform source files are not read, so anchors cannot be shown and freshness cannot be verified";

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The real, canonical path of `relative` under `root`, or why not. Reads nothing but the link structure. */
export async function canonicalPathInside(root: string, relative: string): Promise<CanonicalPath> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "root-inaccessible" };
  }
  let real: string;
  try {
    real = await realpath(join(realRoot, relative));
  } catch {
    return { ok: false, reason: "not-found" };
  }
  return isInside(realRoot, real) ? { ok: true, path: real, root: realRoot } : { ok: false, reason: "outside" };
}

/** Where the open handle really is, or null when the kernel cannot say (fail closed: nothing is vouched for). */
async function handleRealPath(handle: Awaited<ReturnType<typeof open>>): Promise<string | null> {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    return null;
  }
}

/** The bytes of `relative` under `root` (a plain relative path the caller already judged lexically). */
export async function readConfinedFile(root: string, relative: string): Promise<ConfinedRead> {
  if (!confinedReadsSupported()) return { ok: false, reason: "unsupported-platform" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const located = await canonicalPathInside(root, relative);
    if (!located.ok) return located;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(located.path, OPEN_FLAGS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP" && attempt < MAX_ATTEMPTS) continue; // the leaf became a symlink: resolve again
      return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ELOOP" ? "outside" : "not-found" };
    }
    try {
      const opened = await handleRealPath(handle);
      if (opened === null) return { ok: false, reason: "not-found" };
      if (!isInside(located.root, opened)) return { ok: false, reason: "outside" };
      if (!(await handle.stat()).isFile()) return { ok: false, reason: "not-found" };
      return { ok: true, bytes: await handle.readFile(), realPath: opened };
    } catch {
      return { ok: false, reason: "not-found" };
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return { ok: false, reason: "outside" }; // unreachable: the last attempt returns above
}

/** T4 red stub: replaced by the real streaming hash in the fix commit. */
export async function hashConfinedFile(_root: string, _relative: string): Promise<{ ok: true; sha256: string; size: number } | { ok: false; reason: ConfinedReason }> {
  throw new Error("NOT_IMPLEMENTED");
}
