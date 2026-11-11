// Freshness is decided by bytes, never by the git revision (design 4, MC13): fresh / stale with changed
// paths / unknown with inaccessible roots. Round 2 (S1): bytes are read ONLY under roots the operator
// registered; the root an envelope records is never read (it yields `unverified`). These tests use real git
// repositories (git on this host) and real directories; recorded hashes are LITERALS (derivation next to
// each constant). The envelope's recorded root is deliberately a path that does not exist, so every test
// that expects bytes to be read proves the REGISTERED root was used.
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkFreshness, type FreshnessResult } from "./freshness.ts";
import type { RepositoryRegistration } from "./session.ts";
import type { Envelope } from "./wire.ts";
import { observeFilesystem } from "../../test/helpers/fs-spy.ts";
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
const CHANGED = "7f8b1dfc466b6249f06cbe55c9174df2578e7754da793fded244ef5cba2a38f1"; // sha256("changed\n")
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha256("")

const tmp = useTempDirs();

interface Repo { id: string; root: string; gitRev: string | null }
/** The operator's registry for the current test: every repo helper below registers what it creates. */
let registered: RepositoryRegistration[] = [];
beforeEach(() => void (registered = []));
const check = (freshness: Freshness) => checkFreshness(freshness, registered);
function gitRepo(id: string, files: Record<string, string> = { "src/a.txt": "hello\n", "src/b.txt": "world\n" }): Repo {
  const root = join(tmp("fresh"), id);
  registered.push({ id, root });
  return { id, root, gitRev: initGitRepo(root, files) };
}
function plainDir(id: string, files: Record<string, string> = { "src/a.txt": "hello\n", "src/b.txt": "world\n" }): Repo {
  const root = join(tmp("fresh"), id);
  mkdirSync(root, { recursive: true });
  writeFiles(root, files);
  registered.push({ id, root });
  return { id, root, gitRev: null };
}
/** The envelope's record of a repository. Its `root` is a foreign path that must never be read (S1). */
const RECORDED_ROOT = "/recorded/on/another/machine";
const record = (repo: Repo, files: Record<string, string>, dirty = false): Freshness["repositories"][number] => ({
  id: repo.id, root: `${RECORDED_ROOT}/${repo.id}`, gitRev: repo.gitRev, dirty, files,
});
const AB = { "src/a.txt": HELLO, "src/b.txt": WORLD };

describe("checkFreshness: bytes decide", () => {
  // why: the positive control - unchanged bytes are fresh, and the result carries nothing else.
  // proves: CLAIM(MC13)
  it("[MC13] fresh when every recorded file still has the recorded bytes", async () => {
    const repo = gitRepo("A");
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: "Git revision alone cannot identify dirty bytes" (design 4). HEAD is unchanged, a supporting file
  //   was edited: stale, with the exact changed-path record.
  // proves: CLAIM(MC13)
  it("[MC13] HEAD unchanged but file bytes edited: stale with exact changedPaths", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(repo.gitRev);
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: the inverse - a COMMITTED edit changes HEAD and the bytes: stale. (Rules out "fresh whenever HEAD
  //   is a descendant of the recorded rev".)
  // proves: CLAIM(MC13)
  it("[MC13] a committed edit of a supporting file is stale", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    git(repo.root, "commit", "-q", "-am", "edit");
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(repo, AB, true)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: a dirty working tree elsewhere (untracked file, modified unrelated file) is irrelevant to the
  //   recorded files. A "git status is clean" shortcut would report stale.
  // proves: CLAIM(MC13)
  it("[MC13] unrelated dirty and untracked files do not make a view stale", async () => {
    const repo = gitRepo("A", { "src/a.txt": "hello\n", "src/b.txt": "world\n", "notes.md": "n\n" });
    writeFileSync(join(repo.root, "notes.md"), "changed\n");
    writeFileSync(join(repo.root, "untracked.txt"), "u\n");
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: the check is over bytes, so a recorded file that is untracked or ignored by git is still checked.
  // proves: CLAIM(MC13)
  it("[MC13] an untracked recorded file is checked by its bytes", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "scratch.txt"), "hello\n"); // untracked, never added
    const files = { "scratch.txt": HELLO };
    expect(await check({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({ status: "fresh" });
    writeFileSync(join(repo.root, "scratch.txt"), "hello!\n");
    expect(await check({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: hashes are over raw bytes, including NUL and 0xFF, not over a decoded string.
  // proves: CLAIM(MC13)
  it("[MC13] binary content is hashed as raw bytes", async () => {
    const repo = gitRepo("A");
    writeFileSync(join(repo.root, "blob.bin"), Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x00]));
    expect(await check({ repositories: [record(repo, { "blob.bin": BINARY })] })).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: a recorded empty file hashes to sha256(""); "no content" must not be confused with "missing".
  // proves: CLAIM(MC13)
  it("[MC13] an empty recorded file is fresh when still empty, and stale (not null) when it gained bytes", async () => {
    const repo = gitRepo("A", { "empty.txt": "" });
    const files = { "empty.txt": EMPTY };
    expect(await check({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({ status: "fresh" });
    writeFileSync(join(repo.root, "empty.txt"), "hello\n");
    expect(await check({ repositories: [record(repo, files)] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(repo, reversed)] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(dir, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
    writeFileSync(join(dir.root, "src/b.txt"), "WORLD\n");
    expect(await check({ repositories: [record(dir, AB)] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(repo, AB)] })).toEqual<FreshnessResult>({
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
    registered.push({ id: "A", root });
    const result = await check({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: AB }] });
    expect(result).toEqual<FreshnessResult>({ status: "unknown", inaccessibleRoots: [root] });
  });

  // why: with no recorded files there is nothing to compare; an accessible root is fresh and an
  //   inaccessible one is still unknown (accessibility is checked even when files is empty).
  // proves: CLAIM(MC13)
  it("[MC13] a repository with no recorded files: fresh when accessible, unknown when not", async () => {
    const repo = plainDir("P");
    expect(await check({ repositories: [record(repo, {})] })).toEqual<FreshnessResult>({ status: "fresh" });
    const gone = join(tmp("fresh"), "gone");
    registered.push({ id: "G", root: gone });
    expect(await check({ repositories: [{ id: "G", root: gone, gitRev: null, dirty: false, files: {} }] })).toEqual<FreshnessResult>({
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
    expect(await check({ repositories: [record(a, AB), record(b, AB)] })).toEqual<FreshnessResult>({
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
    const result = await check({ repositories: [record(b, AB), record(a, AB)] }); // B first
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
    expect(await check({ repositories: [record(a, AB), record(b, AB)] })).toEqual<FreshnessResult>({ status: "fresh" });
  });
});

describe("checkFreshness: only operator-registered roots are read (S1)", () => {
  // why: S1. An envelope is agent-submitted; the root it records must never authorise a filesystem read. The
  //   repository below exists on disk with the recorded bytes, the envelope names its real path as `root`,
  //   but the operator registered nothing: the answer is `unverified` with a machine-readable code and a
  //   reason, not fresh. Control: the same envelope with the operator's registration is fresh.
  // proves: CLAIM(freshness-registered-roots) CLAIM(MC13) CLAIM(MC15)
  it("[S1] an envelope root that exists and matches is still unverified without a registration; registering it makes it fresh", async () => {
    const repo = gitRepo("A");
    registered = []; // the operator never registered it
    const submitted: Freshness = { repositories: [{ id: "A", root: repo.root, gitRev: repo.gitRev, dirty: false, files: AB }] };
    const result = await check(submitted);
    expect(result).toEqual<FreshnessResult>({
      status: "unverified",
      unverified: [{ repository: "A", code: "REPOSITORY_NOT_REGISTERED", reason: expect.stringMatching(/\S/) }],
    });
    if (result.status === "unverified") expect(result.unverified[0]?.reason).toContain("A");
    expect(await checkFreshness(submitted, [{ id: "A", root: repo.root }])).toEqual<FreshnessResult>({ status: "fresh" });
  });

  // why: S1 "a submitted root cannot read or probe files". If the result differed between a submitted root that
  //   holds the file with the recorded hash, one holding different bytes, one missing the file and one that
  //   does not exist, a hostile envelope could use freshness as an oracle for local files. All four must be
  //   the SAME result (apart from the repository id they name), and none may be `stale`, `fresh` or `unknown`.
  // proves: CLAIM(freshness-registered-roots) CLAIM(MC15)
  it("[S1] a submitted root cannot be probed: matching, differing, missing-file and absent roots all give the identical unverified result", async () => {
    const base = tmp("fresh");
    const matching = join(base, "matching");
    const differing = join(base, "differing");
    const missingFile = join(base, "missing-file");
    mkdirSync(matching); mkdirSync(differing); mkdirSync(missingFile);
    writeFileSync(join(matching, "secret.txt"), "TOP-SECRET-7f3a91\n");
    writeFileSync(join(differing, "secret.txt"), "something else\n");
    const roots = [matching, differing, missingFile, join(base, "absent"), "/etc"];
    const results = [];
    for (const root of roots) {
      results.push(await checkFreshness({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: { "secret.txt": SECRET } }] }, []));
    }
    for (const result of results) {
      expect(result).toEqual<FreshnessResult>({
        status: "unverified",
        unverified: [{ repository: "A", code: "REPOSITORY_NOT_REGISTERED", reason: expect.stringMatching(/\S/) }],
      });
    }
    expect(new Set(results.map((result) => JSON.stringify(result))).size, "one distinct result for every kind of submitted root").toBe(1);
    expect(JSON.stringify(results), "the submitted root string is not echoed back").not.toContain("TOP-SECRET");
    for (const root of roots) expect(JSON.stringify(results)).not.toContain(root);
  });

  // why: the registration, not the envelope, names the root: the registered root has the bytes while the
  //   recorded root is elsewhere (a different machine's path); a registered root with different bytes is
  //   stale even if the recorded root would have matched.
  // proves: CLAIM(MC13)
  it("[S1] the registered root wins over the recorded root, in both directions", async () => {
    const good = plainDir("good");
    const decoy = join(tmp("fresh"), "decoy");
    mkdirSync(decoy);
    writeFiles(decoy, { "src/a.txt": "decoy\n", "src/b.txt": "world\n" });
    const recorded: Freshness = { repositories: [{ id: "good", root: decoy, gitRev: null, dirty: false, files: AB }] };
    expect(await check(recorded)).toEqual<FreshnessResult>({ status: "fresh" });
    const other = plainDir("other", { "src/a.txt": "changed\n", "src/b.txt": "world\n" });
    const recordedOther: Freshness = { repositories: [{ id: "other", root: good.root, gitRev: null, dirty: false, files: AB }] };
    expect(await check(recordedOther)).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "other", path: "src/a.txt", recordedSha256: HELLO, currentSha256: CHANGED }],
      inaccessibleRoots: [],
    });
    expect(other.root).not.toBe(good.root);
  });

  // why: an inaccessible REGISTERED root is reported as the root that was tried (the registered path), and
  //   a repository the operator did not register is listed under `unverified` beside a stale one: nothing is lost.
  // proves: CLAIM(MC13)
  it("[S1] mixed registry: registered-and-stale beside unregistered keeps both facts; unknown beats unverified", async () => {
    const a = gitRepo("A");
    const b = plainDir("B");
    writeFileSync(join(a.root, "src/a.txt"), "hello!\n");
    const stale = await check({ repositories: [record(a, AB), { id: "C", root: "/anywhere", gitRev: null, dirty: false, files: AB }] });
    expect(stale).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "src/a.txt", recordedSha256: HELLO, currentSha256: HELLO_BANG }],
      inaccessibleRoots: [],
      unverified: [{ repository: "C", code: "REPOSITORY_NOT_REGISTERED", reason: expect.stringMatching(/\S/) }],
    });
    rmSync(b.root, { recursive: true, force: true });
    const unknown = await check({ repositories: [record(b, AB), { id: "C", root: "/anywhere", gitRev: null, dirty: false, files: AB }] });
    expect(unknown).toEqual<FreshnessResult>({
      status: "unknown",
      inaccessibleRoots: [b.root],
      unverified: [{ repository: "C", code: "REPOSITORY_NOT_REGISTERED", reason: expect.stringMatching(/\S/) }],
    });
  });

  // why: fresh is a positive claim ("every recorded file was checked"); a registered repository fresh beside an
  //   unregistered one must therefore not be reported fresh.
  // proves: CLAIM(MC13)
  it("[S1] one repository fresh and another unregistered is unverified, not fresh", async () => {
    const a = gitRepo("A");
    expect(await check({ repositories: [record(a, AB), { id: "Z", root: "/z", gitRev: null, dirty: false, files: {} }] })).toEqual<FreshnessResult>({
      status: "unverified",
      unverified: [{ repository: "Z", code: "REPOSITORY_NOT_REGISTERED", reason: expect.stringMatching(/\S/) }],
    });
  });

  // why: checking must not modify its input: the stored envelope is immutable history (design 4).
  // proves: CLAIM(MC13)
  it("[MC13] the freshness argument and the registry are never mutated (deep-equal before and after, stale and fresh)", async () => {
    const repo = gitRepo("A");
    const input: Freshness = { repositories: [record(repo, { ...AB })] };
    const before = structuredClone(input);
    const registryBefore = structuredClone(registered);
    await check(input);
    expect(input).toEqual(before);
    writeFileSync(join(repo.root, "src/a.txt"), "hello!\n");
    expect((await check(input)).status).toBe("stale");
    expect(input).toEqual(before);
    expect(registered).toEqual(registryBefore);
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
    registered.push({ id: "A", root });
    const result = await check({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: { "../secret.txt": SECRET } }] });
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
    registered.push({ id: "A", root });
    const result = await check({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: { "leak.txt": SECRET } }] });
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
    expect(await check({ repositories: [record(dir, { "alias.txt": HELLO })] })).toEqual<FreshnessResult>({ status: "fresh" });
  });
});

describe("checkFreshness: filesystem access is observed, not inferred from the result (N3)", () => {
  /** Runs `check` while recording every fs call; the probe is always stopped. */
  async function observed(freshness: Freshness) {
    const spy = observeFilesystem();
    try {
      return { result: await check(freshness), spy };
    } finally {
      spy.stop();
    }
  }
  const UNVERIFIED_F = [{ repository: "F", code: "REPOSITORY_NOT_REGISTERED" as const, reason: expect.stringMatching(/\S/) }];

  // why: S1 says an envelope root never authorises access. The earlier tests compare RESULTS, so an implementation that stats, lists or
  //   hashes the foreign root and then denies would pass them (a read-before-deny leak: timing and error behaviour still differ, and a
  //   later refactor could start trusting what it read). Here the filesystem itself is observed: nothing under the unregistered root,
  //   by either its lexical or its real path, may be touched by ANY fs call; the registered root IS read in the same call (positive
  //   control: the probe sees this implementation's reads, so silence about the foreign root means something).
  // proves: CLAIM(MC15) CLAIM(MC13) CLAIM(S1-no-probe)
  it("[N3] an unregistered root is never touched by any fs call, while the registered root beside it is read (positive control)", async () => {
    const registeredRepo = plainDir("A");
    const foreign = join(tmp("fresh"), "foreign");
    mkdirSync(foreign);
    writeFiles(foreign, { "src/a.txt": "hello\n", "src/b.txt": "world\n" }); // matching bytes: a read-before-deny would find them fresh
    const { result, spy } = await observed({ repositories: [record(registeredRepo, AB), { id: "F", root: foreign, gitRev: null, dirty: false, files: AB }] });
    expect(result).toEqual<FreshnessResult>({ status: "unverified", unverified: UNVERIFIED_F });
    expect(spy.touching(foreign), "lexical root").toEqual([]);
    expect(spy.touching(realpathSync(foreign)), "real root").toEqual([]);
    expect(spy.touching(registeredRepo.root).length, "positive control: the registered root is read").toBeGreaterThan(0);
    expect(spy.touching(join(registeredRepo.root, "src/a.txt")).length, "the recorded file itself is read").toBeGreaterThan(0);
  });

  // why: the same silence for every shape of foreign root: matching bytes, different bytes, a symlinked directory, an absent path. Each
  //   case also carries the positive control, so a probe that stopped recording cannot make the table pass.
  // proves: CLAIM(S1-no-probe)
  it.each(["matching bytes", "different bytes", "symlink to a directory", "absent"])("[N3] unregistered root with %s: no fs call names it", async (shape) => {
    const registeredRepo = plainDir("A");
    const base = tmp("fresh");
    const real = join(base, "real");
    mkdirSync(real);
    writeFiles(real, { "src/a.txt": shape === "different bytes" ? "other\n" : "hello\n", "src/b.txt": "world\n" });
    const foreign = shape === "symlink to a directory" ? join(base, "link") : shape === "absent" ? join(base, "absent") : real;
    if (shape === "symlink to a directory") symlinkSync(real, foreign);
    const { result, spy } = await observed({ repositories: [record(registeredRepo, AB), { id: "F", root: foreign, gitRev: null, dirty: false, files: AB }] });
    expect(result).toEqual<FreshnessResult>({ status: "unverified", unverified: UNVERIFIED_F });
    for (const path of new Set([foreign, real])) expect(spy.touching(path), `${shape}: ${path}`).toEqual([]);
    expect(spy.touching(registeredRepo.root).length, "positive control").toBeGreaterThan(0);
  });

  // why: a recorded path that climbs out of a REGISTERED root must be refused before it is touched: confirming the hash of a file outside
  //   the root (even only by opening it) is the leak MC15 forbids. The lexical `..` is a decision that needs no filesystem at all.
  // proves: CLAIM(MC15) CLAIM(MC13)
  it("[N3] a recorded ../ path is denied without any fs call naming the file outside the root", async () => {
    const base = tmp("fresh");
    const root = join(base, "repo");
    mkdirSync(root);
    writeFileSync(join(base, "secret.txt"), "TOP-SECRET-7f3a91\n");
    writeFiles(root, { "src/a.txt": "hello\n" });
    registered.push({ id: "A", root });
    const { result, spy } = await observed({ repositories: [{ id: "A", root, gitRev: null, dirty: false, files: { "../secret.txt": SECRET, "src/a.txt": HELLO } }] });
    expect(result).toEqual<FreshnessResult>({
      status: "stale",
      changedPaths: [{ repository: "A", path: "../secret.txt", recordedSha256: SECRET, currentSha256: null }],
      inaccessibleRoots: [],
    });
    expect(spy.touching(join(base, "secret.txt")), "the file outside the root").toEqual([]);
    expect(spy.touching(join(root, "src/a.txt")).length, "positive control: the inside file is read").toBeGreaterThan(0);
  });
});
