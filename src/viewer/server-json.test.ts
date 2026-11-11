// T9 (tier-2 review): server.json holds the session credential. It was written in place with writeFile(mode 0600) and then chmod'ed, so
// (a) a pre-existing server.json that is a symlink or a hard link made the token land in some other file (and chmod that file), and
// (b) another process could read a half-written file. It is now written to a fresh 0600 temp file in the same directory and renamed over
// server.json: the rename replaces whatever was there (a link is replaced, not followed) and readers see the old or the new file whole.
// proves: CLAIM(session-credential) CLAIM(atomic-server-json)
import { linkSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startViewer } from "./server.ts";
import { must } from "../../test/helpers/must.ts";
import { DIST_VIEWER, useViewers } from "../../test/helpers/wire-http.ts";

const viewers = useViewers();
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

const VICTIM = "do not overwrite me\n";
async function start(dir: string) {
  const { session } = await viewers.session({}, dir);
  return viewers.track(must(await startViewer({ session, assetsDirectory: DIST_VIEWER }), "startViewer"));
}

describe("server.json is written by temp file and rename", () => {
  // why: a symlink planted at server.json (by anything that can write the session directory) must not receive the token, and its target must
  //   not be chmod'ed or truncated. After start, server.json is a regular file of its own.
  it("a pre-existing symlink is replaced, not followed: the target keeps its bytes", async () => {
    const dir = viewers.makeTemp("sj-link");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, VICTIM, { mode: 0o644 });
    symlinkSync(victim, join(dir, "server.json"));
    const server = await start(dir);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM);
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    expect(lstatSync(join(dir, "server.json")).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "server.json"), "utf8"))).toEqual({ origin: server.origin, token: server.token, pid: process.pid });
  });

  // why: same for a hard link: writing in place changes the shared inode, so the other name would show the token.
  it("a pre-existing hard link is replaced: the other name keeps its bytes", async () => {
    const dir = viewers.makeTemp("sj-hard");
    const other = join(dir, "other.txt");
    writeFileSync(other, VICTIM, { mode: 0o644 });
    linkSync(other, join(dir, "server.json"));
    await start(dir);
    expect(readFileSync(other, "utf8")).toBe(VICTIM);
    expect(statSync(join(dir, "server.json")).mode & 0o777).toBe(0o600);
  });

  // why: the commit point. At the moment of the rename the temp file must already be complete and private (0600, the whole JSON, the token),
  //   and the rename must target server.json; a reader of server.json can then never see anything else. Observed at the rename call itself.
  it("the file that is renamed onto server.json is complete and mode 0600 at that moment", async () => {
    const dir = viewers.makeTemp("sj-rename");
    const seen: Array<{ from: string; to: string; mode: number; content: string }> = [];
    const original = fsPromises.rename;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("server.json")) seen.push({ from: String(from), to: String(to), mode: statSync(String(from)).mode & 0o777, content: readFileSync(String(from), "utf8") });
      return original(from, to);
    });
    syncBuiltinESMExports();
    const server = await start(dir);
    expect(seen).toHaveLength(1);
    const [renamed] = seen as [(typeof seen)[number]];
    expect(renamed.to).toBe(join(dir, "server.json"));
    expect(renamed.from).not.toBe(renamed.to);
    expect(renamed.from.startsWith(join(dir, "server.json"))).toBe(true); // a sibling temp name in the same directory (same filesystem)
    expect(renamed.mode).toBe(0o600);
    expect(JSON.parse(renamed.content)).toEqual({ origin: server.origin, token: server.token, pid: process.pid });
  });

  // why: no temp file is left behind after a normal start, and close() still removes server.json (the lifecycle tests of server.test.ts keep
  //   covering the rest).
  it("leaves no temp file behind and removes server.json on close", async () => {
    const dir = viewers.makeTemp("sj-clean");
    const server = await start(dir);
    const { readdirSync, existsSync } = await import("node:fs");
    expect(readdirSync(dir).filter((name) => name.startsWith("server.json"))).toEqual(["server.json"]);
    await server.close();
    expect(existsSync(join(dir, "server.json"))).toBe(false);
  });
});
