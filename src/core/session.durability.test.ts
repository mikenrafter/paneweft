// T10 (tier-2 review): the manifest was fsynced before its rename, but the object files it points at were only written and renamed, with no fsync of
// the files or of the directory entries. After a power loss the (durable) manifest could name objects whose bytes or directory entries never reached the
// disk. Staging now fsyncs each object file before renaming it into place, then the objects directory and the session directory, and only then
// writes, fsyncs and renames the manifest.
// The order is observed at the file-system calls themselves (open/sync/rename are wrapped for one import), not through a hook of the code under test:
// a handle's path is remembered when it is opened, and every FileHandle.sync and fs.promises.rename is logged as a normalised event.
// proves: CLAIM(atomic-manifest) CLAIM(durable-objects)
import { basename, dirname, join } from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../test/helpers/must.ts";
import { openOk, subBundle } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

/** Wraps open / FileHandle.sync / rename and returns the event log (paths normalised against `dir`). */
async function observe(dir: string): Promise<string[]> {
  const events: string[] = [];
  const paths = new WeakMap<object, string>();
  const originalOpen = fsPromises.open;
  const probe = await originalOpen(import.meta.filename);
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const originalSync = proto.sync;
  const kindOf = (path: string): string => {
    if (path === dir) return "session-dir";
    if (path === join(dir, "objects")) return "objects-dir";
    if (dirname(path) === join(dir, "objects")) return "object";
    if (dirname(path) === dir && basename(path).startsWith("manifest.json")) return "manifest";
    return `other:${path}`;
  };
  vi.spyOn(fsPromises, "open").mockImplementation((async (path: Parameters<typeof originalOpen>[0], ...rest: unknown[]) => {
    const handle = await (originalOpen as (...args: unknown[]) => ReturnType<typeof originalOpen>)(path, ...rest);
    paths.set(handle, String(path));
    return handle;
  }) as typeof fsPromises.open);
  vi.spyOn(proto, "sync").mockImplementation(async function (this: object) {
    events.push(`sync:${kindOf(paths.get(this) ?? "?")}`);
    return originalSync.call(this);
  });
  const originalRename = fsPromises.rename;
  vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    events.push(`rename:${kindOf(String(to))}`);
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  return events;
}

describe("session writes are durable in the right order (T10)", () => {
  // why: the finding. Two new objects are staged: each file is fsynced and THEN renamed into place; after the last rename the objects directory and the
  //   session directory are fsynced (the entries and the directory's creation); only then is the manifest fsynced and renamed (the commit point).
  it("importing two new views: object sync+rename x2, objects-dir sync, session-dir sync, manifest sync, manifest rename", async () => {
    const dir = join(tmp("durable"), "s");
    const session = await openOk(dir);
    const events = await observe(dir);
    must(await session.importBundle(subBundle(["modules", "layout"])));
    expect(events.filter((event) => !event.startsWith("sync:other") && !event.startsWith("rename:other"))).toEqual([
      "sync:object", "rename:object",
      "sync:object", "rename:object",
      "sync:objects-dir", "sync:session-dir",
      "sync:manifest", "rename:manifest",
    ]);
  });

  // why: nothing staged, nothing to make durable: re-importing the same view writes no object, so only the manifest is synced and renamed (the
  //   extra fsyncs are not paid when there is no new object).
  it("re-importing identical content syncs only the manifest", async () => {
    const dir = join(tmp("durable"), "s");
    const session = await openOk(dir);
    must(await session.importBundle(subBundle(["modules"])));
    const events = await observe(dir);
    must(await session.importBundle(subBundle(["modules"])));
    expect(events).toEqual(["sync:manifest", "rename:manifest"]);
  });

  // why: a rejected request stages nothing and writes nothing, so it fsyncs nothing either.
  it("a rejected import performs no sync and no rename", async () => {
    const dir = join(tmp("durable"), "s");
    const session = await openOk(dir);
    const events = await observe(dir);
    const rejected = await session.importBundle({ schemaVersion: "paneweft.bundle/1" });
    expect(rejected.ok).toBe(false);
    expect(events).toEqual([]);
  });
});
