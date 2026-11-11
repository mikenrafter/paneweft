// T4 (tier-2 review): a confined read returned whatever size the file had, into memory, so a registered root holding a multi-gigabyte file made
// an anchor read, a freshness check or an asset request allocate it all. Now the handle is fstat'ed BEFORE any read, files over 16 MiB are
// answered `too-large` (freshness: `unknown` with code FILE_TOO_LARGE; link currency `unknown`; anchor: FILE_TOO_LARGE), and hashing streams in
// 64 KiB chunks. Boundary values are literals: 16 MiB = 16777216 bytes is read, one byte more is refused. Files are sparse (truncate), so the
// boundary costs no disk. Expected hashes come from python3 hashlib, not from this repo.
// proves: CLAIM(confined-read) CLAIM(bounded-confined-read)
import { mkdirSync, realpathSync, truncateSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSourceAnchor } from "./anchors.ts";
import { hashConfinedFile, readConfinedFile } from "./confined-read.ts";
import { checkFreshness, currentFileHash } from "./freshness.ts";
import { freshnessLine } from "./summaries.ts";
import { rawRequest, useViewers } from "../../test/helpers/wire-http.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const LIMIT = 16_777_216; // 16 MiB
const ZEROS_16_MIB = "080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e"; // hashlib.sha256(bytes(16*1024*1024))
const HELLO = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"; // sha256("hello\n")

const tmp = useTempDirs();
const viewers = useViewers();
afterEach(() => vi.restoreAllMocks());

function world() {
  const root = join(realpathSync(tmp("size")), "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "small.txt"), "hello\n");
  const sized = (name: string, size: number) => { writeFileSync(join(root, name), ""); truncateSync(join(root, name), size); };
  sized("exact.bin", LIMIT);
  sized("over.bin", LIMIT + 1);
  return { root, repos: [{ id: "r", root }] };
}

/** A read result without its bytes: a failing assertion would otherwise diff a 16 MiB Buffer element by element and kill the worker. */
const shape = (read: Awaited<ReturnType<typeof readConfinedFile>>) => (read.ok ? { ok: true as const, bytes: read.bytes.length } : read);

/** The FileHandle class's own prototype, whose methods the confined reader calls on every handle it opens. */
async function fileHandlePrototype(root: string): Promise<Record<string, (...args: any[]) => any>> {
  const handle = await open(join(root, "small.txt"));
  try { return Object.getPrototypeOf(handle) as Record<string, (...args: any[]) => any>; } finally { await handle.close(); }
}

describe("readConfinedFile: the 16 MiB boundary", () => {
  // why: boundary pair. A file of exactly the limit is read in full; one byte more is refused with a reason, not read.
  it("exactly 16777216 bytes is read; 16777217 is too-large", async () => {
    const { root } = world();
    expect(shape(await readConfinedFile(root, "exact.bin"))).toEqual({ ok: true, bytes: LIMIT });
    expect(shape(await readConfinedFile(root, "over.bin"))).toEqual({ ok: false, reason: "too-large" });
  });

  // why: the point of the cap is that an oversized file is never read at all: after fstat the reader must not call read/readFile on the handle.
  it("an oversized file is fstat'ed and never read", async () => {
    const { root } = world();
    const proto = await fileHandlePrototype(root);
    const calls: string[] = [];
    for (const name of ["stat", "read", "readFile"]) {
      const original = proto[name] as (...args: any[]) => any;
      vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: any[]) { calls.push(name); return original.apply(this, args); });
    }
    expect(shape(await readConfinedFile(root, "over.bin"))).toEqual({ ok: false, reason: "too-large" });
    expect(calls).toContain("stat");
    expect(calls.filter((name) => name !== "stat")).toEqual([]);
  });

  // why: a file can grow between the fstat and the read. The read itself is bounded, so growth past the limit is still too-large rather than
  //   an unbounded read. The growth is injected right after the reader's fstat, deterministically.
  it("a file that grows past the limit after the fstat is still refused", async () => {
    const { root } = world();
    const proto = await fileHandlePrototype(root);
    const original = proto.stat as (...args: any[]) => Promise<unknown>;
    let grown = false;
    vi.spyOn(proto, "stat").mockImplementation(async function (this: unknown, ...args: any[]) {
      const result = await original.apply(this, args);
      if (!grown) { grown = true; truncateSync(join(root, "small.txt"), LIMIT + 10); }
      return result;
    });
    expect(shape(await readConfinedFile(root, "small.txt"))).toEqual({ ok: false, reason: "too-large" });
    expect(grown).toBe(true);
  });
});

describe("hashConfinedFile: streaming", () => {
  // why: the hash of a file at the limit equals the independently computed one, and one byte more is too-large (same boundary as the read).
  it("hashes 16777216 zero bytes to the python hash, refuses 16777217, and hashes a small file", async () => {
    const { root } = world();
    expect(await hashConfinedFile(root, "exact.bin")).toMatchObject({ ok: true, sha256: ZEROS_16_MIB, size: LIMIT });
    expect(await hashConfinedFile(root, "over.bin")).toEqual({ ok: false, reason: "too-large" });
    expect(await hashConfinedFile(root, "small.txt")).toMatchObject({ ok: true, sha256: HELLO, size: 6 });
  });

  // why: "hash as a stream": no readFile of the whole file, and no single read larger than 64 KiB, so memory stays bounded however large a
  //   file under the cap is.
  it("never calls readFile and reads at most 64 KiB at a time", async () => {
    const { root } = world();
    const proto = await fileHandlePrototype(root);
    const lengths: number[] = [];
    let readFileCalls = 0;
    const read = proto.read as (...args: any[]) => any;
    const readFile = proto.readFile as (...args: any[]) => any;
    vi.spyOn(proto, "read").mockImplementation(function (this: unknown, ...args: any[]) {
      lengths.push(typeof args[0] === "object" && !Buffer.isBuffer(args[0]) ? (args[0].length ?? 0) : (args[2] ?? (args[0] as Buffer).length));
      return read.apply(this, args);
    });
    vi.spyOn(proto, "readFile").mockImplementation(function (this: unknown, ...args: any[]) { readFileCalls += 1; return readFile.apply(this, args); });
    expect(await hashConfinedFile(root, "exact.bin")).toMatchObject({ ok: true, sha256: ZEROS_16_MIB });
    expect(readFileCalls).toBe(0);
    expect(lengths.length).toBeGreaterThanOrEqual(256);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(65_536);
  });
});

describe("freshness and anchors answer for a file over the limit", () => {
  // why: currentFileHash is what freshness and source currency call; at the limit it hashes, above it says too-large (never a hash, never null).
  it("currentFileHash: present with the hash at the limit, too-large above it", async () => {
    const { repos } = world();
    expect(await currentFileHash(repos, "r", "exact.bin")).toEqual({ state: "present", sha256: ZEROS_16_MIB });
    expect(await currentFileHash(repos, "r", "over.bin")).toEqual({ state: "too-large" });
  });

  const record = (files: Record<string, string>) => ({ repositories: [{ id: "r", root: "/elsewhere", gitRev: null, dirty: false, files }] });

  // why: freshness cannot say fresh or stale for a file it did not hash, so the answer is `unknown`, with a machine-readable code and the file named;
  //   it must not be `fresh` (the old behaviour for an unreadable-big file was a null hash, i.e. `stale`).
  it("checkFreshness: a recorded file over the limit makes the repository `unknown` with FILE_TOO_LARGE naming it", async () => {
    const { repos } = world();
    const result = await checkFreshness(record({ "small.txt": HELLO, "over.bin": ZEROS_16_MIB }), repos);
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") return;
    expect(result.inaccessibleRoots).toEqual([]);
    expect(result.unverified).toEqual([{ repository: "r", code: "FILE_TOO_LARGE", paths: ["over.bin"], reason: expect.stringContaining("over.bin") }]);
    expect(freshnessLine(result)).toMatch(/^unknown \(too large to hash: r:over\.bin\)$/);
  });

  // why: precedence is unchanged: a file that really changed makes the view stale even when another file is too large to check.
  it("checkFreshness: a changed file wins over a too-large one (stale), and the too-large file is still reported", async () => {
    const { repos } = world();
    const result = await checkFreshness(record({ "small.txt": ZEROS_16_MIB, "over.bin": ZEROS_16_MIB }), repos);
    expect(result.status).toBe("stale");
    expect(result.status === "stale" && result.unverified?.map((entry) => entry.code)).toEqual(["FILE_TOO_LARGE"]);
  });

  // why: control: a file exactly at the limit is hashed, so a matching record is fresh (the cap does not misfire at the boundary).
  it("checkFreshness: a file exactly at the limit is hashed and fresh when it matches", async () => {
    const { repos } = world();
    expect(await checkFreshness(record({ "exact.bin": ZEROS_16_MIB }), repos)).toEqual({ status: "fresh" });
  });

  // why: anchors need the bytes to number lines; above the limit that is refused with a named code, at the limit it works.
  it("resolveSourceAnchor: FILE_TOO_LARGE above the limit, resolved at the limit", async () => {
    const { repos } = world();
    const brief = (result: Awaited<ReturnType<typeof resolveSourceAnchor>>) => (result.ok ? { ok: true, fileSha256: result.value.fileSha256 } : { ok: false, code: result.error.code, message: result.error.message });
    const over = brief(await resolveSourceAnchor(repos, { repository: "r", path: "over.bin", lines: [1, 1] }));
    expect(over).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
    expect(over.message).toContain("16777216");
    expect(brief(await resolveSourceAnchor(repos, { repository: "r", path: "exact.bin", lines: [1, 1] }))).toEqual({ ok: true, fileSha256: ZEROS_16_MIB });
  });

  // why: the viewer reads static assets through the same function; an oversized asset is refused (404), never loaded into the server's memory.
  it("the viewer does not serve an asset over the limit", async () => {
    const { root } = world();
    const { server } = await viewers.start({}, { assetsDirectory: root });
    expect((await rawRequest(server, "/assets/over.bin")).status).toBe(404);
    expect((await rawRequest(server, "/assets/small.txt")).status).toBe(200);
  });
});
