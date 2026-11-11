// why: N3 relies on the probe seeing every way code can touch a path. A probe that misses `stat` or a by-name import would let a
//   read-before-deny implementation pass. Each API family is exercised for real against a temp directory, and nothing is recorded
//   after stop() or for a path nobody touched (positive and negative controls). Green by design; independent of src/.
import fs, { createReadStream, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observeFilesystem } from "./fs-spy.ts";
import { useTempDirs } from "./tmp.ts";

const tmp = useTempDirs();
function seeded() {
  const root = tmp("spy");
  fs.writeFileSync(join(root, "a.txt"), "hello\n");
  fs.mkdirSync(join(root, "sub"));
  fs.writeFileSync(join(root, "sub", "b.txt"), "world\n");
  return root;
}

describe("fs-spy", () => {
  it("records sync, callback, promise and stream access, by-name imports included, with the path they named", async () => {
    const root = seeded();
    const spy = observeFilesystem();
    try {
      readFileSync(join(root, "a.txt"));
      statSync(join(root, "sub"));
      await readFile(join(root, "sub", "b.txt"));
      await stat(root);
      await fs.promises.readdir(root);
      fs.realpathSync(join(root, "a.txt"));
      await fs.promises.realpath(join(root, "a.txt"));
      fs.accessSync(root);
      await new Promise<void>((resolveStream) => createReadStream(join(root, "a.txt")).on("data", () => {}).on("close", resolveStream));
    } finally {
      spy.stop();
    }
    const apis = new Set(spy.touching(root).map((call) => call.api));
    for (const api of ["fs.readFileSync", "fs.statSync", "fs.promises.readFile", "fs.promises.stat", "fs.promises.readdir", "fs.realpathSync", "fs.promises.realpath", "fs.accessSync", "fs.createReadStream"]) {
      expect(apis.has(api), `${api} is observed`).toBe(true);
    }
    expect(spy.touching(join(root, "sub", "b.txt")).map((call) => call.api)).toContain("fs.promises.readFile");
  });

  it("records nothing for untouched paths and nothing after stop(); stop is idempotent and restores the real functions", async () => {
    const root = seeded();
    const other = seeded();
    const originalReadFile = fs.promises.readFile;
    const spy = observeFilesystem();
    expect(fs.promises.readFile).not.toBe(originalReadFile);
    readFileSync(join(root, "a.txt"));
    const recordedWhileObserving = spy.touching(root).length;
    expect(recordedWhileObserving, "the read is seen while observing").toBeGreaterThan(0); // one public call may fan out into several (open, read)
    spy.stop();
    spy.stop();
    expect(fs.promises.readFile).toBe(originalReadFile);
    readFileSync(join(root, "a.txt"));
    await readFile(join(other, "a.txt"));
    expect(spy.touching(other)).toEqual([]);
    expect(spy.touching(root), "nothing is recorded after stop()").toHaveLength(recordedWhileObserving);
  });

  it("does not treat a sibling directory with a common name prefix as inside the root", () => {
    const base = tmp("spy");
    fs.mkdirSync(join(base, "repo"));
    fs.mkdirSync(join(base, "repo-evil"));
    const spy = observeFilesystem();
    try { statSync(join(base, "repo-evil")); } finally { spy.stop(); }
    expect(spy.touching(join(base, "repo"))).toEqual([]);
    expect(spy.touching(join(base, "repo-evil")).length).toBeGreaterThan(0);
  });
});
