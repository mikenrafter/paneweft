// Input fingerprints, sampled consistency and package membership (S10, N5; IV18) against real git repositories in temp dirs.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git, makeRepo, write } from "../../test/helpers/v1-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { must } from "../../test/helpers/must.ts";
import { compareFingerprints, computeFingerprint, sampleConsistency } from "./fingerprint.ts";

const tmp = useTempDirs();
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function crate(): string {
  const dir = tmp("fp");
  makeRepo(dir, {
    ".gitignore": "target/\n",
    "Cargo.lock": "lock-v1\n",
    "crates/foo/Cargo.toml": "[package]\nname = \"foo\"\n",
    "crates/foo/src/lib.rs": "pub mod tracked;\n",
    "crates/foo/src/tracked.rs": "// tracked\n",
    "other/unrelated.rs": "// outside the crate\n",
  });
  return dir;
}
const options = (dir: string, extra: object = {}) => ({ root: join(dir, "crates/foo"), declaredExtras: ["Cargo.lock"], ...extra });
const paths = async (dir: string, extra: object = {}) => must(await computeFingerprint(options(dir, extra)), "fingerprint").members.map((m) => m.path);

describe("[N5] membership", () => {
  // why: N5. Members = tracked files + untracked non-ignored files under the root + declared extras. Paths are relative to the crate
  // root for files under it, and as declared for extras. The ignored `target/` output and the file outside the crate are excluded.
  // proves: CLAIM(N5-membership) CLAIM(IV18)
  it("includes tracked, untracked non-ignored and declared extras; excludes ignored and outside files", async () => {
    const dir = crate();
    write(dir, "crates/foo/src/untracked.rs", "// untracked, imported by lib.rs\n");
    write(dir, "crates/foo/target/debug/junk.o", "ignored output\n");
    expect(await paths(dir)).toEqual(["../../Cargo.lock", "Cargo.toml", "src/lib.rs", "src/tracked.rs", "src/untracked.rs"].sort());
  });

  // why: N5 tests: an edit to an imported untracked module changes the fingerprint and is reported as modified; a deleted one as
  // deleted. This is the case a tracked-files-only digest misses.
  // proves: CLAIM(N5-membership) CLAIM(IV18)
  it("an edit to and the deletion of an untracked module are detected", async () => {
    const dir = crate();
    write(dir, "crates/foo/src/untracked.rs", "// v1\n");
    const captured = must(await computeFingerprint(options(dir)), "captured");
    write(dir, "crates/foo/src/untracked.rs", "// v2\n");
    const edited = must(await computeFingerprint(options(dir)), "edited");
    expect(edited.digest).not.toBe(captured.digest);
    expect(compareFingerprints(captured, edited)).toEqual({ status: "stale", reasons: [{ path: "src/untracked.rs", change: "modified" }] });
    rmSync(join(dir, "crates/foo/src/untracked.rs"));
    const deleted = must(await computeFingerprint(options(dir)), "deleted");
    expect(compareFingerprints(captured, deleted)).toEqual({ status: "stale", reasons: [{ path: "src/untracked.rs", change: "deleted" }] });
  });

  // why: S10 tests for added and deleted files: an added file and a deleted tracked file both make results stale, with their change kind.
  // proves: CLAIM(S10-sampled-consistency) CLAIM(IV18)
  it("an added file and a deleted tracked file are stale with their change kinds", async () => {
    const dir = crate();
    const captured = must(await computeFingerprint(options(dir)), "captured");
    write(dir, "crates/foo/src/added.rs", "// added\n");
    rmSync(join(dir, "crates/foo/src/tracked.rs"));
    const current = must(await computeFingerprint(options(dir)), "current");
    expect(compareFingerprints(captured, current)).toEqual({ status: "stale", reasons: [{ path: "src/added.rs", change: "added" }, { path: "src/tracked.rs", change: "deleted" }] });
  });

  // why: a change to a declared extra input (the lockfile outside the crate) makes results stale.
  // proves: CLAIM(IV18)
  it("a declared extra input counts", async () => {
    const dir = crate();
    const captured = must(await computeFingerprint(options(dir)), "captured");
    write(dir, "Cargo.lock", "lock-v2\n");
    const current = must(await computeFingerprint(options(dir)), "current");
    expect(compareFingerprints(captured, current).reasons).toEqual([{ path: "../../Cargo.lock", change: "modified" }]);
  });

  // why: exclusions are explicit and recorded; an excluded file never changes the digest, and the fingerprint says what was excluded.
  // proves: CLAIM(S10-sampled-consistency)
  it("explicit exclusions are applied and listed", async () => {
    const dir = crate();
    const withExclusion = must(await computeFingerprint(options(dir, { exclusions: ["src/tracked.rs"] })), "excluded");
    expect(withExclusion.members.map((m) => m.path)).not.toContain("src/tracked.rs");
    expect(withExclusion.exclusions).toEqual(["src/tracked.rs"]);
    write(dir, "crates/foo/src/tracked.rs", "// edited but excluded\n");
    const after = must(await computeFingerprint(options(dir, { exclusions: ["src/tracked.rs"] })), "after");
    expect(after.digest).toBe(withExclusion.digest);
  });

  // why: the digest is sha256 over the sorted member lines `<path>\0<sha256>\n` (docs/v1-red-contract.md section 10) computed here
  // independently; it does not depend on file creation order.
  // proves: CLAIM(IV18)
  it("the digest is the hash of the sorted member list", async () => {
    const dir = crate();
    const fingerprint = must(await computeFingerprint(options(dir)), "fingerprint");
    const members = [["../../Cargo.lock", "lock-v1\n"], ["Cargo.toml", "[package]\nname = \"foo\"\n"], ["src/lib.rs", "pub mod tracked;\n"], ["src/tracked.rs", "// tracked\n"]].sort(([a], [b]) => (a! < b! ? -1 : 1));
    expect(fingerprint.members).toEqual(members.map(([path, text]) => ({ path, sha256: sha(text!) })));
    expect(fingerprint.digest).toBe(sha(members.map(([path, text]) => `${path}\0${sha(text!)}\n`).join("")));
    expect(git(dir, "status", "--porcelain")).toBe("");
  });
});

describe("[S10] sampled consistency", () => {
  // why: S10 wording. Before/after hashing is "sampled consistency": equal samples say so in those words and never claim the inputs
  // did not change during the run. The mid-run edit that is RESTORED before the second sample is documented as undetectable.
  // proves: CLAIM(S10-sampled-consistency)
  it("equal samples are consistent-sampled; the note says sampled, not proven", async () => {
    const dir = crate();
    const before = must(await computeFingerprint(options(dir)), "before");
    write(dir, "crates/foo/src/tracked.rs", "// edited mid-run\n");
    write(dir, "crates/foo/src/tracked.rs", "// tracked\n"); // restored: invisible to two samples
    const after = must(await computeFingerprint(options(dir)), "after");
    const verdict = sampleConsistency(before, after);
    expect(verdict.status).toBe("consistent-sampled");
    expect(verdict.note.toLowerCase()).toContain("sampled");
    expect(verdict.note.toLowerCase()).not.toMatch(/never changed|did not change|unchanged during/);
    expect(verdict.note.toLowerCase()).toContain("restored");
  });

  // why: S10 / IV18. A file that differs between the two samples makes the run mixed-input, with the paths.
  // proves: CLAIM(S10-sampled-consistency) CLAIM(IV18)
  it("a file that differs between the samples makes the run mixed-input", async () => {
    const dir = crate();
    const before = must(await computeFingerprint(options(dir)), "before");
    write(dir, "crates/foo/src/lib.rs", "pub mod tracked;\npub mod late;\n");
    const after = must(await computeFingerprint(options(dir)), "after");
    expect(sampleConsistency(before, after)).toMatchObject({ status: "mixed-input", changed: [{ path: "src/lib.rs", change: "modified" }] });
  });

  // why: identical fingerprints compare fresh with no reasons (positive control for the stale cases above).
  // proves: CLAIM(IV18)
  it("identical fingerprints are fresh", async () => {
    const dir = crate();
    const a = must(await computeFingerprint(options(dir)), "a");
    const b = must(await computeFingerprint(options(dir)), "b");
    expect(compareFingerprints(a, b)).toEqual({ status: "fresh", reasons: [] });
  });
});
