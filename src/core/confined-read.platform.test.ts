// Review round 2, S1: the non-Linux fallback of confined-read.ts compared a device/inode with a re-resolved PATHNAME, which keeps the
// check-to-use window open. Decision: v0 confined reads are Linux-only (they need /proc/self/fd); on any other platform they fail closed
// with UNSUPPORTED_PLATFORM instead of a weaker read. The platform is injected through `pretendPlatform`, because this suite runs on Linux.
// proves: CLAIM(confined-read) CLAIM(contained-assets) CLAIM(anchor-roots)
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSourceAnchor } from "./anchors.ts";
import { pretendPlatform, readConfinedFile } from "./confined-read.ts";
import { checkFreshness, currentFileHash } from "./freshness.ts";
import { sha256Hex } from "./digest.ts";
import { rawRequest, useViewers } from "../../test/helpers/wire-http.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const INSIDE = "inside line\n";
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
const on = (platform: string) => { restores.push(pretendPlatform(platform)); };
const viewers = useViewers();
const tmp = useTempDirs();

function world() {
  const base = realpathSync(tmp("confined-platform"));
  const root = join(base, "repo");
  mkdirSync(join(root, "dir"), { recursive: true });
  writeFileSync(join(root, "f.txt"), INSIDE);
  writeFileSync(join(root, "dir", "f.txt"), INSIDE);
  return { root, repos: [{ id: "r", root }] };
}

describe("[S1/r2] without /proc/self/fd a confined read fails closed", () => {
  // why: the fallback re-resolved a pathname after the open, so a swap in that window still escaped; no read may be offered where the handle check is impossible.
  it.each(["darwin", "win32", "freebsd"])("%s: readConfinedFile answers unsupported-platform for a file that exists inside the root", async (platform) => {
    const { root } = world();
    on(platform);
    expect(await readConfinedFile(root, "f.txt")).toEqual({ ok: false, reason: "unsupported-platform" });
  });

  // control: the same call on linux reads, so the refusal above is about the platform and not about the fixture.
  it("control: on linux the same file is read", async () => {
    const { root } = world();
    on("linux");
    expect(await readConfinedFile(root, "f.txt")).toMatchObject({ ok: true, realPath: join(root, "f.txt") });
  });

  // why: an agent must be told the platform is the reason (a NOT_FOUND would send it hunting for a missing file).
  it("anchors: resolveSourceAnchor says UNSUPPORTED_PLATFORM and returns no file text", async () => {
    const { repos } = world();
    on("darwin");
    const result = await resolveSourceAnchor(repos, { repository: "r", path: "f.txt", lines: [1, 1] });
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PLATFORM", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("inside line");
  });

  // why: reporting "changed" or "fresh" without having read anything would be a false claim; the repository is unverified, with the reason.
  it("freshness: a recorded file under a registered root is unverified (UNSUPPORTED_PLATFORM), neither fresh nor stale", async () => {
    const { repos } = world();
    on("darwin");
    expect(await currentFileHash(repos, "r", "f.txt")).toEqual({ state: "unsupported-platform" });
    const result = await checkFreshness({ repositories: [{ id: "r", files: { "f.txt": sha256Hex(INSIDE) } }] } as never, repos);
    expect(result).toMatchObject({ status: "unverified", unverified: [{ repository: "r", code: "UNSUPPORTED_PLATFORM" }] });
    expect((result as { unverified: Array<{ reason: string }> }).unverified[0]?.reason).toMatch(/linux|platform/i);
  });

  it("control: on linux the same record is fresh", async () => {
    const { repos } = world();
    on("linux");
    expect(await checkFreshness({ repositories: [{ id: "r", files: { "f.txt": sha256Hex(INSIDE) } }] } as never, repos)).toEqual({ status: "fresh" });
  });
});

describe("[S1/r2] without /proc/self/fd the viewer serves only its fixed bundle", () => {
  // why: the viewer still has to show its own page; it does so from the regular files that were direct children of the bundle directory
  //      at start-up, held in memory, so nothing on disk is consulted (or swappable) per request, and nothing outside that set is served.
  it("serves a bundle file, refuses a nested path, a symlink, a later addition, and ignores a swap after start", async () => {
    const { root } = world();
    symlinkSync(join(root, "f.txt"), join(root, "file-link.txt"));
    on("darwin");
    const { server } = await viewers.start({}, { assetsDirectory: root });
    expect(await rawRequest(server, "/assets/f.txt")).toMatchObject({ status: 200, text: INSIDE });
    expect((await rawRequest(server, "/assets/dir/f.txt")).status).toBe(404);
    expect((await rawRequest(server, "/assets/file-link.txt")).status).toBe(404);
    expect((await rawRequest(server, "/assets/%2e%2e/repo/f.txt")).status).toBe(404);
    writeFileSync(join(root, "late.txt"), "late\n");
    expect((await rawRequest(server, "/assets/late.txt")).status).toBe(404);
    writeFileSync(join(root, "f.txt"), "changed on disk\n");
    expect(await rawRequest(server, "/assets/f.txt")).toMatchObject({ status: 200, text: INSIDE });
  });

  // control: on linux the same directory behaves as before (nested path served), so the refusals above come from the platform.
  it("control: on linux a nested path and a valid internal symlink are served", async () => {
    const { root } = world();
    symlinkSync(join(root, "f.txt"), join(root, "file-link.txt"));
    on("linux");
    const { server } = await viewers.start({}, { assetsDirectory: root });
    expect(await rawRequest(server, "/assets/dir/f.txt")).toMatchObject({ status: 200, text: INSIDE });
    expect(await rawRequest(server, "/assets/file-link.txt")).toMatchObject({ status: 200, text: INSIDE });
  });
});
