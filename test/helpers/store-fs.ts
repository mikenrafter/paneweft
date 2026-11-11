// Filesystem helpers for the store suites (anchors, freshness, session, runner).
// Independent of src/: these observe a directory from the outside, so "nothing changed on disk" claims
// do not rely on the code under test to report them.
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256Hex } from "./hash.ts";

export interface TreeEntry { path: string; kind: "file" | "dir" | "symlink"; sha256: string }

/** Every file, directory and symlink below `dir` (symlinks are not followed), sorted by relative path. */
export function treeSnapshot(dir: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) entries.push({ path: rel, kind: "symlink", sha256: "" });
      else if (stat.isDirectory()) {
        entries.push({ path: rel, kind: "dir", sha256: "" });
        walk(full);
      } else entries.push({ path: rel, kind: "file", sha256: sha256Hex(readFileSync(full)) });
    }
  };
  walk(dir);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Relative paths of regular files below `dir` whose UTF-8 text contains `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  return treeSnapshot(dir)
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path)
    .filter((path) => readFileSync(join(dir, path), "utf8").includes(needle));
}

/** Relative paths of every directory below `dir`, plus "" for `dir` itself. */
export function directoriesIn(dir: string): string[] {
  return ["", ...treeSnapshot(dir).filter((entry) => entry.kind === "dir").map((entry) => entry.path)];
}

export function overwrite(path: string, text: string): void {
  writeFileSync(path, text);
}
