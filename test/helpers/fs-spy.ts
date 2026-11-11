// A filesystem access probe for "this code never touched that path" claims (final review N3). Result-only assertions cannot tell a
// check that denied a path from one that read it first and denied afterwards; this records every fs call that names a path.
// How: every public function of node:fs and node:fs/promises is wrapped for the lifetime of one observation, then the builtin ESM
// named exports are re-synced, so code that imported `readFile` by name is observed as well as code that calls `fs.readFile`.
// Limits (claimed, not hidden): calls made through an already opened descriptor/handle are not path calls (the open is recorded),
// and native addons or child processes are invisible. Paths are recorded as absolute lexical paths (path.resolve, no symlink resolution).
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface FsCall { api: string; path: string }
export interface FsObservation {
  /** Every recorded call so far, in order. */
  readonly calls: readonly FsCall[];
  /** Calls whose path is `root` or lies under it. */
  touching(root: string): FsCall[];
  /** Restores the real functions. Idempotent. */
  stop(): void;
}

function asPath(argument: unknown): string | null {
  if (typeof argument === "string") return resolve(argument);
  if (argument instanceof URL) return argument.protocol === "file:" ? fileURLToPath(argument) : null;
  if (Buffer.isBuffer(argument)) return resolve(argument.toString("utf8"));
  return null;
}

export function observeFilesystem(): FsObservation {
  const calls: FsCall[] = [];
  const restorations: Array<() => void> = [];
  function wrap(owner: Record<string, unknown>, label: string): void {
    for (const name of Object.keys(owner)) {
      const original = owner[name];
      if (typeof original !== "function" || /^[A-Z]/.test(name)) continue; // classes (Dirent, Stats, ReadStream, ...) are not path calls
      const wrapper = function (this: unknown, ...args: unknown[]) {
        for (const argument of args.slice(0, 2)) {
          const path = asPath(argument);
          if (path !== null) calls.push({ api: `${label}.${name}`, path });
        }
        return Reflect.apply(original, this, args);
      };
      Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original)); // keeps .native, util.promisify.custom, name, length
      owner[name] = wrapper;
      restorations.push(() => void (owner[name] = original));
    }
  }
  wrap(fs as unknown as Record<string, unknown>, "fs");
  wrap(fsPromises as unknown as Record<string, unknown>, "fs.promises");
  syncBuiltinESMExports();
  let stopped = false;
  return {
    calls,
    touching: (root) => calls.filter((call) => call.path === root || call.path.startsWith(root.endsWith(sep) ? root : root + sep)),
    stop() {
      if (stopped) return;
      stopped = true;
      for (const restore of restorations.reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}
