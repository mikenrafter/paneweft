// Freshness is decided by bytes, never by the git revision (design 4, MC13): fresh / stale with changed
// paths / unknown with inaccessible roots. These tests use real git repositories (git on this host) and
// real directories; recorded hashes are LITERALS (derivation next to each constant).
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFreshness, type FreshnessResult } from "./freshness.ts";
import type { Envelope } from "./wire.ts";
import { git, initGitRepo, writeFiles } from "../../test/helpers/git.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

type Freshness = Envelope["freshness"];
const HELLO = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"; // sha256("hello\n")
const WORLD = "e258d248fda94c63753607f7c4494ee0fcbe92f1a76bfdac795c9d84101eb317"; // sha256("world\n")
const HELLO_BANG = "c8a31cb076b21999bd2cdcfa5f446a7a6644de88037087112fa18bd90cc13984"; // sha256("hello!\n")
const WORLD_UPPER = "5ece97172554920a9872271d89d6087ce5633c2e2c93d4b5fac0ac7d4a083ad2"; // sha256("WORLD\n")
const WORLD_BANG = "15296cbd7565d6b3583fcfe1d92246cbe27bd9b7c5862784c78f1176c3b622b0"; // sha256("world!\n")
const BINARY = "485d42e2c2452309d12ec342cb2a2aad5c6ed117d349841f79ae6fe3aee1d48d"; // sha256 of bytes 00 ff 10 0a 00
const SECRET = "bca36a07b8f2cff02008612a0e623375a682851b218099ce7a52dfa3e2a2aea3"; // sha256("TOP-SECRET-7f3a91\n")
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha256("")

const tmp = useTempDirs();

interface Repo { id: string; root: string; gitRev: string | null }
function gitRepo(id: string, files: Record<string, string> = { "src/a.txt": "hello\n", "src/b.txt": "world\n" }): Repo {
  const root = join(tmp("fresh"), id);
  return { id, root, gitRev: initGitRepo(root, files) };
}
function plainDir(id: string, files: Record<string, string> = { "src/a.txt": "hello\n", "src/b.txt": "world\n" }): Repo {
  const root = join(tmp("fresh"), id);
  mkdirSync(root, { recursive: true });
  writeFiles(root, files);
  return { id, root, gitRev: null };
}
const record = (repo: Repo, files: Record<string, string>, dirty = false): Freshness["repositories"][number] => ({
  id: repo.id, root: repo.root, gitRev: repo.gitRev, dirty, files,
});
const AB = { "src/a.txt": HELLO, "src/b.txt": WORLD };

describe("checkFreshness: bytes decide", () => {
  // why: the positive control - unchanged bytes are fresh, and the result carries nothing else.
  // proves: CLAIM(MC13)
  it("[MC13] fresh when every recorded file still has the recorded bytes", async () => {
    const repo = gitRepo("A");
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: "Git revision alone cannot identify dirty bytes" (design 4). HEAD is unchanged, a supporting file
  //   was edited: stale, with the exact changed-path record.
  // proves: CLAIM(MC13)
  it("[MC13] HEAD unchanged but file bytes edited: stale with exact changedPaths", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(repo.gitRev);
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "src/a.txt", recordedSha256: HELLO, currentSha256: HELLO_BANG }],
      inaccessibleRoots: [],
    });
  });

  // why: a deleted supporting file is a change; its current hash is null, not an error and not "fresh".
  // proves: CLAIM(MC13)
  it("[MC13] deleted file: stale with currentSha256 null", async () => {
    const repo = gitRepo("A");
    rmSync(join(repo.root, "src/b.txt"));
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "src/b.txt", recordedSha256: WORLD, currentSha256: null }],
      inaccessibleRoots: [],
    });
  });

  // why: bytes decide, not the git rev. HEAD moved because of an unrelated commit; the supporting bytes
  //   are equal, so the view is still fresh. A mutation comparing gitRev would report stale.
  // proves: CLAIM(MC13)
  it("[MC13] HEAD moved by an unrelated commit but supporting bytes equal: still fresh", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "unrelated.txt"), "x\n");
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-q", "-m", "unrelated");
    expect(git(repo.root, "rev-parse", "HEAD")).not.toBe(repo.gitRev);
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: the inverse - a COMMITTED edit changes HEAD and the bytes: stale. (Rules out "fresh whenever HEAD
  //   is a descendant of the recorded rev".)
  // proves: CLAIM(MC13)
  it("[MC13] a committed edit of a supporting file is stale", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    git(repo.root, "commit", "-q", "-am", "edit");
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "src/a.txt", recordedSha256: HELLO, currentSha256: HELLO_BANG }],
      inaccessibleRoots: [],
    });
  });

  // why: `dirty: true` records that the inspected tree was dirty; it does not make the view stale by
  //   itself. If the recorded bytes are still there it is fresh.
  // proves: CLAIM(MC13)
  it("[MC13] dirty:true recorded and bytes equal: fresh", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "src/a.txt"), "hello\n"); // identical rewrite
    expect(await checkFreshness({ repositories: [record(repo, AB, true)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: a dirty working tree elsewhere (untracked file, modified unrelated file) is irrelevant to the
  //   recorded files. A "git status is clean" shortcut would report stale.
  // proves: CLAIM(MC13)
  it("[MC13] unrelated dirty and untracked files do not make a view stale", async () => {
    const repo = gitRepo("A", { "src/a.txt": "hello\n", "src/b.txt": "world\n", "notes.md": "n\n" });
    writeFileSync(join(repo.root, "notes.md"), "changed\n");
    writeFileSync(join(repo.root, "untracked.txt"), "u\n");
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: the check is over bytes, so a recorded file that is untracked or ignored by git is still checked.
  // proves: CLAIM(MC13)
  it("[MC13] an untracked recorded file is checked by its bytes", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "scratch.txt"), "hello\n"); // untracked, never added
    const files = { "scratch.txt": HELLO };
    expect(await checkFreshness({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({ status: "fresh" });
    writeFileSync(join(repo.root, "scratch.txt"), "hello!\n");
    expect(await checkFreshness({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "scratch.txt", recordedSha256: HELLO, currentSha256: HELLO_BANG }],
      inaccessibleRoots: [],
    });
  });

  // why: edit-then-revert leaves the same bytes; a change-detection based on mtime would call it stale.
  // proves: CLAIM(MC13)
  it("[MC13] a file edited and restored to the recorded bytes is fresh", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    writeFileSync(join(repo.root, "src/a.txt"), "hello\n");
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: hashes are over raw bytes, including NUL and 0xFF, not over a decoded string.
  // proves: CLAIM(MC13)
  it("[MC13] binary content is hashed as raw bytes", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "blob.bin"), Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x00]));
    expect(await checkFreshness({ repositories: [record(repo, { "blob.bin": BINARY })] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: a recorded empty file hashes to sha256(""); "no content" must not be confused with "missing".
  // proves: CLAIM(MC13)
  it("[MC13] an empty recorded file is fresh when still empty, and stale (not null) when it gained bytes", async () => {
    const repo = gitRepo("A", { "empty.txt": "" });
    const files = { "empty.txt": EMPTY };
    expect(await checkFreshness({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({ status: "fresh" });
    writeFileSync(join(repo.root, "empty.txt"), "hello\n");
    expect(await checkFreshness({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "empty.txt", recordedSha256: EMPTY, currentSha256: HELLO }],
      inaccessibleRoots: [],
    });
  });

  // why: changedPaths order must be deterministic and independent of the key order of `files`: repository
  //   order of the envelope, then path in code-unit order (store.md#3).
  // proves: CLAIM(MC13)
  it("[MC13] several changed files are listed sorted by path regardless of recorded key order", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    rmSync(join(repo.root, "src/b.txt"));
    const reversed = { "src/b.txt": WORLD, "src/a.txt": HELLO };
    expect(await checkFreshness({ repositories: [record(repo, reversed)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [
        { repository: "A", path: "src/a.txt", recordedSha256: HELLO, currentSha256: HELLO_BANG },
        { repository: "A", path: "src/b.txt", recordedSha256: WORLD, currentSha256: null },
      ],
      inaccessibleRoots: [],
    });
  });
});

describe("checkFreshness: no git, inaccessible roots, several repositories", () => {
  // why: non-Git roots use gitRev null and keep hashes (design 4); fresh and stale work the same way.
  // proves: CLAIM(MC13)
  it("[MC13] a directory without git (gitRev null) is fresh and then stale by hashes", async () => {
    const dir = plainDir("P");
    expect(await checkFreshness({ repositories: [record(dir, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
    writeFileSync(join(dir.root, "src/b.txt"), "WORLD\n");
    expect(await checkFreshness({ repositories: [record(dir, AB)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "P", path: "src/b.txt", recordedSha256: WORLD, currentSha256: WORLD_UPPER }],
      inaccessibleRoots: [],
    });
  });

  // why: an inaccessible root is UNKNOWN - not fresh (nothing was verified) and not stale (nothing was
  //   found to differ); the root is listed so the user knows what to restore.
  // proves: CLAIM(MC13)
  it("[MC13] root directory removed: unknown, listing that root, neither fresh nor stale", async () => {
    const repo = gitRepo("A");
    rmSync(repo.root, { recursive: true, force: true });
    expect(await checkFreshness({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
      status: "unknown",
      inaccessibleRoots: [repo.root],
    });
  });

  // why: a root that exists but is a FILE (or otherwise unreadable as a directory) is inaccessible too.
  // proves: CLAIM(MC13)
  it("[MC13] a root that is a regular file instead of a directory is inaccessible", async () => {
    const dir = tmp("fresh");
    const root = join(dir, "not-a-dir");
    writeFileSync(root, "x");
    const result = await checkFreshness({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: AB }] });
    expect(result).toEqual<FreshnessResult>({ status: "unknown", inaccessibleRoots: [root] });
  });

  // why: with no recorded files there is nothing to compare; an accessible root is fresh and an
  //   inaccessible one is still unknown (accessibility is checked even when files is empty).
  // proves: CLAIM(MC13)
  it("[MC13] a repository with no recorded files: fresh when accessible, unknown when not", async () => {
    const repo = plainDir("P");
    expect(await checkFreshness({ repositories: [record(repo, {})] })).toEqual<FreshnessResult>({ status: "fresh" });
    const gone = join(tmp("fresh"), "gone");
    expect(await checkFreshness({ repositories: [{ id: "G", root: gone, gitRev: null, dirty: false, files: {} }] })).toEqual<FreshnessResult>({
      status: "unknown", inaccessibleRoots: [gone],
    });
  });

  // why: stale wins over unknown: one repository has a changed file, another cannot be read. Both facts
  //   are reported (design 4 lists changed paths AND inaccessible roots).
  // proves: CLAIM(MC13)
  it("[MC13] one repository changed and another inaccessible: stale with both lists", async () => {
    const a = gitRepo("A");
    const b = gitRepo("B");
    writeFileSync(join(a.root, "src/a.txt"), "hello!\n");
    rmSync(b.root, { recursive: true, force: true });
    expect(await checkFreshness({ repositories: [record(a, AB), record(b, AB)] })).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "src/a.txt", recordedSha256: HELLO, currentSha256: HELLO_BANG }],
      inaccessibleRoots: [b.root],
    });
  });

  // why: two repositories; changes are attributed to the right repository id, in envelope order.
  // proves: CLAIM(MC13)
  it("[MC13] two repositories: each changed path is attributed to its repository, in envelope order", async () => {
    const a = gitRepo("A");
    const b = plainDir("B");
    writeFileSync(join(a.root, "src/b.txt"), "world!\n");
    rmSync(join(b.root, "src/a.txt"));
    const result = await checkFreshness({ repositories: [record(b, AB), record(a, AB)] }); // B first
    expect(result).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [
        { repository: "B", path: "src/a.txt", recordedSha256: HELLO, currentSha256: null },
        { repository: "A", path: "src/b.txt", recordedSha256: WORLD, currentSha256: WORLD_BANG },
      ],
      inaccessibleRoots: [],
    });
  });

  // why: control for the two-repository tests: both unchanged is fresh, so the rejections above come from
  //   the edits and not from having two repositories.
  // proves: CLAIM(MC13)
  it("[MC13] two unchanged repositories are fresh", async () => {
    const a = gitRepo("A");
    const b = plainDir("B");
    expect(await checkFreshness({ repositories: [record(a, AB), record(b, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });
});

describe("checkFreshness: rootOverrides and purity", () => {
  // why: an envelope records the root of the machine that produced it; on another machine the viewer
  //   passes the local root. The override replaces the recorded root.
  // proves: CLAIM(MC13)
  it("[MC13] rootOverrides replaces the recorded root: a missing recorded root becomes fresh via the override", async () => {
    const repo = gitRepo("A");
    const recorded: Freshness = { repositories: [{ id: "A", root: "/definitely/not/here", gitRev: repo.gitRev, dirty: false, files: AB }] };
    expect(await checkFreshness(recorded)).toEqual<FreshnessResult>({ status: "unknown", inaccessibleRoots: ["/definitely/not/here"] });
    expect(await checkFreshness(recorded, { A: repo.root })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: the override wins even when the recorded root exists with different bytes; otherwise the stale
  //   recorded directory would be silently used.
  // proves: CLAIM(MC13)
  it("[MC13] the override wins over an existing recorded root", async () => {
    const stale = plainDir("old", { "src/a.txt": "something else\n", "src/b.txt": "world\n" });
    const good = plainDir("new");
    const recorded: Freshness = { repositories: [{ id: "A", root: stale.root, gitRev: null, dirty: false, files: AB }] };
    expect((await checkFreshness(recorded)).status).toBe("stale");
    expect(await checkFreshness(recorded, { A: good.root })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: an inaccessible OVERRIDE is reported as the root that was tried (the override path).
  // proves: CLAIM(MC13)
  it("[MC13] an inaccessible override is the root listed as inaccessible", async () => {
    const repo = gitRepo("A");
    const missing = join(tmp("fresh"), "missing");
    const result = await checkFreshness({ repositories: [record(repo, AB)] }, { A: missing });
    expect(result).toEqual<FreshnessResult>({ status: "unknown", inaccessibleRoots: [missing] });
  });

  // why: checking must not modify its input: the stored envelope is immutable history (design 4).
  // proves: CLAIM(MC13)
  it("[MC13] the freshness argument is never mutated (deep-equal before and after, stale and fresh)", async () => {
    const repo = gitRepo("A");
    const input: Freshness = { repositories: [record(repo, { ...AB })] };
    const before = structuredClone(input);
    await checkFreshness(input);
    expect(input).toEqual(before);
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    expect((await checkFreshness(input)).status).toBe("stale");
    expect(input).toEqual(before);
  });
});

describe("checkFreshness: never reads outside the root", () => {
  // why: MC15 "no source reads outside registered roots". If a hostile envelope records `../secret.txt`
  //   with the secret's real hash, an implementation that reads it would answer "fresh" and confirm the
  //   secret's content by hash. The path is reported as changed with currentSha256 null.
  // proves: CLAIM(MC13) CLAIM(MC15)
  it("[MC13] a recorded path escaping the root by .. is treated as unreadable, never hashed", async () => {
    const base = tmp("fresh");
    const root = join(base, "repo");
    mkdirSync(root);
    writeFileSync(join(base, "secret.txt"), "TOP-SECRET-7f3a91\n");
    const result = await checkFreshness({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: { "../secret.txt": SECRET } }] });
    expect(result).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "../secret.txt", recordedSha256: SECRET, currentSha256: null }],
      inaccessibleRoots: [],
    });
  });

  // why: same escape through a symlink inside the root (realpath check, not a lexical one).
  // proves: CLAIM(MC13) CLAIM(MC15)
  it("[MC13] a recorded path that is a symlink leaving the root is treated as unreadable, never hashed", async () => {
    const base = tmp("fresh");
    const root = join(base, "repo");
    mkdirSync(root);
    writeFileSync(join(base, "secret.txt"), "TOP-SECRET-7f3a91\n");
    symlinkSync("../secret.txt", join(root, "leak.txt"));
    const result = await checkFreshness({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: { "leak.txt": SECRET } }] });
    expect(result).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "leak.txt", recordedSha256: SECRET, currentSha256: null }],
      inaccessibleRoots: [],
    });
  });

  // why: control for the two cases above: a symlink INSIDE the root to an inside file is hashed normally.
  // proves: CLAIM(MC13)
  it("[MC13] a symlink inside the root to an inside file is hashed (positive control)", async () => {
    const dir = plainDir("P");
    symlinkSync("src/a.txt", join(dir.root, "alias.txt"));
    expect(await checkFreshness({ repositories: [record(dir, { "alias.txt": HELLO })] })).toEqual<FreshnessResult>({ status: "fresh" });
  });
});
