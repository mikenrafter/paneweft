import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/** Call once per describe/file: returns a factory of temp directories removed after each test. */
export function useTempDirs(): (name?: string) => string {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return (name = "t") => {
    const dir = mkdtempSync(join(tmpdir(), `paneweft-${name}-`));
    created.push(dir);
    return dir;
  };
}
export function ensureDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
