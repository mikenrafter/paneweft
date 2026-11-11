// Review S1: containment was checked on canonical paths and the file was then read by PATHNAME, so a file or an ancestor swapped
// for a symlink between the check and the read escaped the registered root (source text, freshness hashes, served assets).
// These tests close the check-to-use window deterministically (test/helpers/fs-swap.ts) at all three read sites:
// resolveSourceAnchor (anchors.ts), currentFileHash (freshness.ts) and the viewer's static files (server.ts).
// Every swap test asserts the swap fired (no vacuous pass) and has a control with a VALID internal symlink that must still be read.
// proves: CLAIM(anchor-roots) CLAIM(contained-assets) CLAIM(confined-read)
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSourceAnchor } from "./anchors.ts";
import { currentFileHash } from "./freshness.ts";
import { sha256Hex } from "./digest.ts";
import { swapAfterRealpath, type RealpathSwap } from "../../test/helpers/fs-swap.ts";
import { rawRequest, useViewers } from "../../test/helpers/wire-http.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const SECRET = "TOP-SECRET-c0ffee11";
const INSIDE = "inside line\n";

const swaps: RealpathSwap[] = [];
afterEach(() => { for (const swap of swaps.splice(0)) swap.restore(); });
const viewers = useViewers();
const tmp = useTempDirs();

// base/outside/f.txt holds the secret; base/repo/f.txt and base/repo/dir/f.txt are the legitimate files.
function world() {
  const base = realpathSync(tmp("confined"));
  const root = join(base, "repo");
  mkdirSync(join(root, "dir"), { recursive: true });
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "outside", "f.txt"), `${SECRET}\n`);
  writeFileSync(join(root, "f.txt"), INSIDE);
  writeFileSync(join(root, "dir", "f.txt"), INSIDE);
  return { base, root, repos: [{ id: "r", root }] };
}
/** Replace `<root>/f.txt` by a symlink to the outside secret, at the moment its containment check has passed. */
const swapLeaf = (root: string, base: string) => swapAfterRealpath((resolved) => resolved === join(root, "f.txt"), () => {
  rmSync(join(root, "f.txt"));
  symlinkSync(join(base, "outside", "f.txt"), join(root, "f.txt"));
});
/** Replace the ancestor `<root>/dir` by a symlink to the outside directory (which also holds an f.txt). */
const swapAncestor = (root: string, base: string) => swapAfterRealpath((resolved) => resolved === join(root, "dir", "f.txt"), () => {
  renameSync(join(root, "dir"), join(root, "dir.moved"));
  symlinkSync(join(base, "outside"), join(root, "dir"));
});
const track = (swap: RealpathSwap) => { swaps.push(swap); return swap; };

describe("[S1] resolveSourceAnchor reads only a handle that is verified inside the root", () => {
  // why: the file was read by pathname after the check; a symlink swapped in at that moment returned the outside secret as source text.
  it("a file swapped for a symlink to an outside file after the check is refused and nothing outside is returned", async () => {
    const { base, root, repos } = world();
    const swap = track(swapLeaf(root, base));
    const result = await resolveSourceAnchor(repos, { repository: "r", path: "f.txt", lines: [1, 1] });
    expect(swap.fired(), "the swap must have run inside the check-to-use window").toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_ROOT" } });
  });

  // why: O_NOFOLLOW on the leaf alone does not see an ancestor directory turned into a symlink; the opened handle's own real path must be checked.
  it("an ancestor directory swapped for a symlink to an outside directory after the check is refused", async () => {
    const { base, root, repos } = world();
    const swap = track(swapAncestor(root, base));
    const result = await resolveSourceAnchor(repos, { repository: "r", path: "dir/f.txt", lines: [1, 1] });
    expect(swap.fired()).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_ROOT" } });
  });

  // control: confinement must not break legitimate internal symlinks (file and directory), or the guard would be "refuse everything".
  it("control: a valid internal file symlink and a valid internal directory symlink are still read", async () => {
    const { root, repos } = world();
    symlinkSync(join(root, "f.txt"), join(root, "file-link.txt"));
    symlinkSync(join(root, "dir"), join(root, "dir-link"));
    for (const path of ["f.txt", "file-link.txt", "dir-link/f.txt"]) {
      const result = await resolveSourceAnchor(repos, { repository: "r", path, lines: [1, 1] });
      expect(result, path).toMatchObject({ ok: true, value: { numberedLines: [{ n: 1, text: "inside line" }], fileSha256: sha256Hex(INSIDE) } });
    }
  });
});

describe("[S1] currentFileHash hashes only a handle that is verified inside the root", () => {
  // why: hashing the swapped-in outside file turns freshness into an oracle for the content of any file the process can read
  //      (record the secret's hash, learn "fresh"). The outside file must read as unreachable (sha256 null), not as a hash.
  it.each([
    ["a file swapped for an outside symlink", "f.txt", swapLeaf],
    ["an ancestor swapped for an outside symlink", "dir/f.txt", swapAncestor],
  ] as const)("%s after the check yields no hash", async (_name, path, makeSwap) => {
    const { base, root, repos } = world();
    const swap = track(makeSwap(root, base));
    const current = await currentFileHash(repos, "r", path);
    expect(swap.fired()).toBe(true);
    expect(current).toEqual({ state: "present", sha256: null });
    expect(current).not.toEqual({ state: "present", sha256: sha256Hex(`${SECRET}\n`) });
  });

  it("control: a valid internal symlink is hashed", async () => {
    const { root, repos } = world();
    symlinkSync(join(root, "f.txt"), join(root, "file-link.txt"));
    expect(await currentFileHash(repos, "r", "file-link.txt")).toEqual({ state: "present", sha256: sha256Hex(INSIDE) });
  });
});

describe("[S1] the viewer serves a static file only from a handle verified inside the assets directory", () => {
  // why: the served HTML/JS was read by pathname after the containment check; the swap served an outside file.
  it.each([
    ["a file swapped for an outside symlink", "/assets/f.txt", swapLeaf],
    ["an ancestor swapped for an outside symlink", "/assets/dir/f.txt", swapAncestor],
  ] as const)("%s after the check is not served", async (_name, target, makeSwap) => {
    const { base, root } = world();
    const { server } = await viewers.start({}, { assetsDirectory: root });
    const swap = track(makeSwap(root, base));
    const reply = await rawRequest(server, target);
    expect(swap.fired()).toBe(true);
    expect(reply.text).not.toContain(SECRET);
    expect([403, 404]).toContain(reply.status);
  });

  it("control: a valid internal symlink in the assets directory is served", async () => {
    const { root } = world();
    symlinkSync(join(root, "f.txt"), join(root, "file-link.txt"));
    const { server } = await viewers.start({}, { assetsDirectory: root });
    const reply = await rawRequest(server, "/assets/file-link.txt");
    expect(reply).toMatchObject({ status: 200, text: INSIDE });
  });
});
