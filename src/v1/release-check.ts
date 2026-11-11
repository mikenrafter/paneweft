// Stripping checks (IV4): compiled dependency graphs and bundle artifacts, never an environment variable's name.
import type { Result } from "../core/errors.ts";
import { notImplemented } from "./stub.ts";

export interface ReleaseGraphReport {
  clean: boolean;
  /** When not clean: the dependency path from the root package to the instrumentation crate, e.g. ["release-leaky", "watchfile", "paneweft"]. */
  paths: string[][];
}

/** Resolves the dependency graph the RELEASE recipe builds (`cargo metadata` / `cargo tree -e normal`, default features, no
 * `--features paneweft`) and reports every path that reaches `forbiddenCrate` (accidental feature activation through a dependency
 * included). STUB. */
export function checkCargoReleaseGraph(manifestPath: string, forbiddenCrate: string): Promise<Result<ReleaseGraphReport>> {
  return Promise.resolve(notImplemented("checkCargoReleaseGraph"));
}

export interface BundleReport {
  clean: boolean;
  /** Evidence when not clean: which marker was found and in which module. */
  findings: Array<{ marker: string; module: string }>;
}

/** Bundles `entry` for production with esbuild and looks for the SDK sentinel and the registration/capture hooks in the output
 * AND the metafile's input list. STUB. */
export function checkBundleStripping(entry: string, markers: string[]): Promise<Result<BundleReport>> {
  return Promise.resolve(notImplemented("checkBundleStripping"));
}
