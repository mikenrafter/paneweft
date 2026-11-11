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
// Size: the opened handle is fstat'ed BEFORE anything is read; a file over MAX_CONFINED_FILE_BYTES (16 MiB) is `too-large` and never read.
//   The read itself is also bounded (chunks, counted), so a file that grows after the fstat cannot be pulled into memory either.
//   Hashing streams in 64 KiB chunks and holds no more than one chunk.
// CLAIM(bounded-confined-read): no confined read or hash buffers more than MAX_CONFINED_FILE_BYTES, whatever the file does after the fstat
//   [confined-read.size.test.ts].
// Errors: returns a reason, never throws and never echoes file content or the outside path:
//   root-inaccessible (root cannot be resolved), not-found (missing, unreadable, or not a regular file), outside (leaves the root),
//   unsupported-platform (no /proc/self/fd: the read is refused rather than weakened), too-large (over the cap).
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

export type ConfinedReason = "root-inaccessible" | "not-found" | "outside" | "unsupported-platform" | "too-large";
export type CanonicalPath = { ok: true; path: string; root: string } | { ok: false; reason: ConfinedReason };
export type ConfinedRead = { ok: true; bytes: Buffer; realPath: string } | { ok: false; reason: ConfinedReason };
export type ConfinedHash = { ok: true; sha256: string; size: number; realPath: string } | { ok: false; reason: ConfinedReason };

/** The largest file a confined read or hash will take: 16 MiB (a source file, a recorded anchor target or a viewer asset is far smaller). */
export const MAX_CONFINED_FILE_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

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

type Handle = Awaited<ReturnType<typeof open>>;

/**
 * Opens `relative` under `root` as a handle verified inside the root and fstat'ed as a regular file of at most MAX_CONFINED_FILE_BYTES, then
 * runs `use` on it; the handle is closed afterwards. `use` returns null when the content grew past the cap while it was being read.
 */
async function withVerifiedHandle<T>(root: string, relative: string, use: (handle: Handle, info: { realPath: string; size: number }) => Promise<T | null>): Promise<{ ok: true; value: T } | { ok: false; reason: ConfinedReason }> {
  if (!confinedReadsSupported()) return { ok: false, reason: "unsupported-platform" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const located = await canonicalPathInside(root, relative);
    if (!located.ok) return located;
    let handle: Handle;
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
      const info = await handle.stat(); // fstat of the open handle, before any read
      if (!info.isFile()) return { ok: false, reason: "not-found" };
      if (info.size > MAX_CONFINED_FILE_BYTES) return { ok: false, reason: "too-large" };
      const value = await use(handle, { realPath: opened, size: info.size });
      return value === null ? { ok: false, reason: "too-large" } : { ok: true, value };
    } catch {
      return { ok: false, reason: "not-found" };
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return { ok: false, reason: "outside" }; // unreachable: the last attempt returns above
}

/** Reads the handle chunk by chunk, calling `take` on each; false once more than MAX_CONFINED_FILE_BYTES came out (the file grew after the fstat). */
async function drain(handle: Handle, take: (chunk: Buffer) => void): Promise<boolean> {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
    if (bytesRead === 0) return true;
    total += bytesRead;
    if (total > MAX_CONFINED_FILE_BYTES) return false;
    take(chunk.subarray(0, bytesRead));
  }
}

/** The bytes of `relative` under `root` (a plain relative path the caller already judged lexically), or why not. At most MAX_CONFINED_FILE_BYTES. */
export async function readConfinedFile(root: string, relative: string): Promise<ConfinedRead> {
  const read = await withVerifiedHandle(root, relative, async (handle, info) => {
    const parts: Buffer[] = [];
    const within = await drain(handle, (chunk) => void parts.push(Buffer.from(chunk))); // copy: the chunk buffer is reused
    return within ? { bytes: Buffer.concat(parts), realPath: info.realPath } : null;
  });
  return read.ok ? { ok: true, bytes: read.value.bytes, realPath: read.value.realPath } : read;
}

/** sha256 of `relative` under `root`, streamed through the verified handle in 64 KiB chunks; at most MAX_CONFINED_FILE_BYTES. */
export async function hashConfinedFile(root: string, relative: string): Promise<ConfinedHash> {
  const hashed = await withVerifiedHandle(root, relative, async (handle, info) => {
    const hash = createHash("sha256");
    let size = 0;
    const within = await drain(handle, (chunk) => { hash.update(chunk); size += chunk.length; });
    return within ? { sha256: hash.digest("hex"), size, realPath: info.realPath } : null;
  });
  return hashed.ok ? { ok: true, ...hashed.value } : hashed;
}
