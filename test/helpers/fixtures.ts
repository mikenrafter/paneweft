// Fixture access. Fixtures are committed, hand-reviewed JSON (fixtures/README.md), never generated at test time.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = join(REPO_ROOT, "fixtures");

/** Pinned by name on purpose: emptying this list must break tests (test-quality §8, "iterating over the current set"). */
export const V0_COMPONENTS = ["list", "tree", "graph", "source", "shape", "notebook", "example"] as const;
export type V0Component = (typeof V0_COMPONENTS)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function loadFixture<T = Json>(relativePath: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, relativePath), "utf8")) as T;
}
export function componentFixture(component: V0Component): Record<string, any> {
  return loadFixture(`components/${component}.json`);
}
export function allBundle(): Record<string, any> {
  return loadFixture("components/all.bundle.json");
}
export function clone<T>(value: T): T {
  return structuredClone(value);
}
