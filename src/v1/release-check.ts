// Stripping checks (IV4): compiled dependency graphs and bundle artifacts, never an environment variable's name.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { err, ok, type Result } from "../core/errors.ts";

const run = promisify(execFile);

export interface ReleaseGraphReport {
  clean: boolean;
  /** When not clean: the dependency path from the root package to the instrumentation crate, e.g. ["release-leaky", "watchfile", "paneweft"]. */
  paths: string[][];
}

interface Metadata {
  packages: Array<{ id: string; name: string }>;
  resolve: { root: string | null; nodes: Array<{ id: string; deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }> }> };
}

/** Resolves the dependency graph the RELEASE recipe builds (`cargo metadata`, default features, no `--features paneweft`) and reports
 * every path of NORMAL dependencies that reaches `forbiddenCrate` (accidental feature activation through a dependency included). */
export async function checkCargoReleaseGraph(manifestPath: string, forbiddenCrate: string): Promise<Result<ReleaseGraphReport>> {
  let metadata: Metadata;
  try {
    const { stdout } = await run(process.env.CARGO ?? "cargo", ["metadata", "--format-version", "1", "--manifest-path", manifestPath], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
    metadata = JSON.parse(stdout) as Metadata;
  } catch (cause) {
    return err("RUNNER_FAILED", `cargo metadata failed for ${manifestPath}: ${(cause as Error).message}`.slice(0, 1000));
  }
  if (metadata.resolve.root === null) return err("INVALID_ARGUMENT", `${manifestPath} is a virtual workspace: name a package manifest`);
  const names = new Map(metadata.packages.map((pkg) => [pkg.id, pkg.name]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const paths: string[][] = [];
  const walk = (id: string, trail: string[]): void => {
    const name = names.get(id) ?? id;
    if (trail.includes(name)) return;
    const here = [...trail, name];
    if (name === forbiddenCrate) {
      paths.push(here);
      return;
    }
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((kind) => kind.kind === null)) walk(dep.pkg, here);
  };
  walk(metadata.resolve.root, []);
  return ok({ clean: paths.length === 0, paths });
}

export interface BundleReport {
  clean: boolean;
  /** Evidence when not clean: which marker was found and in which module. */
  findings: Array<{ marker: string; module: string }>;
}

/** Bundles `entry` for production with esbuild and looks for the SDK sentinel and the registration/capture hooks in the output
 * AND the metafile's input list. Tree shaking is off on purpose: the question is whether the entry can REACH the SDK, and a bundler
 * that happens to drop an unused export is not a guarantee. */
export async function checkBundleStripping(entry: string, markers: string[]): Promise<Result<BundleReport>> {
  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, platform: "node", format: "esm", treeShaking: false, logLevel: "silent", absWorkingDir: dirname(entry), outdir: "out" });
  } catch (cause) {
    return err("RUNNER_FAILED", `esbuild failed for ${entry}: ${(cause as Error).message}`.slice(0, 1000));
  }
  const findings: BundleReport["findings"] = [];
  const bundled = new Set<string>();
  for (const output of Object.values((result.metafile as NonNullable<typeof result.metafile>).outputs)) for (const [input, detail] of Object.entries(output.inputs)) if (detail.bytesInOutput > 0 || true) bundled.add(input);
  const root = dirname(entry);
  const absolute = (input: string): string => (isAbsolute(input) ? input : join(root, input));
  const text = (result.outputFiles ?? []).map((file) => file.text).join("\n");
  const sources = new Map<string, string>();
  for (const input of bundled) sources.set(input, await readFile(absolute(input), "utf8").catch(() => ""));
  for (const marker of markers) {
    if (!text.includes(marker)) continue;
    const owners = [...sources.entries()].filter(([, source]) => source.includes(marker)).map(([input]) => input);
    if (owners.length === 0) findings.push({ marker, module: "<bundle>" });
    for (const owner of owners) findings.push({ marker, module: owner });
  }
  for (const input of bundled) if (/packages\/paneweft-ts\/|\.paneweft\.[cm]?[jt]s$/.test(input) && !findings.some((finding) => finding.module === input)) findings.push({ marker: "instrumentation-module", module: input });
  return ok({ clean: findings.length === 0, findings });
}
