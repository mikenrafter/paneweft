// What a scaffold reads from the owner's checked-out repository so that its output applies as given (F12): whether the SDK is wired, whether
// the file it patches already has a module of the name it would emit, whether a manifest and the reporter exist. Reading only: a scaffold
// writes nothing. Every read is bounded and confined to the adapter root; a file that is absent or unreadable is "unknown", never an error.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRecord } from "./adapters.ts";

const READ_LIMIT = 1_000_000;
const SCAN_FILES = 400;

/** The paneweft checkout this host runs from: the scripts and packages a scaffold's setup commands name live here. */
export const CHECKOUT_ROOT = resolvePath(fileURLToPath(new URL("../..", import.meta.url)));

/** The adapter's package directory (`workspaceRoot/entry`). */
export const adapterRoot = (adapter: AdapterRecord): string => resolvePath(join(adapter.workspaceRoot, adapter.entry));

function readInside(root: string, relative: string): string | undefined {
  const path = resolvePath(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
  try {
    if (!statSync(path).isFile() || statSync(path).size > READ_LIMIT) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** True when `text` declares a Rust module called `name` (`mod name {` or `mod name;`), comments aside. */
export const declaresRustModule = (text: string | undefined, name: string): boolean => text !== undefined && new RegExp(`(^|[^\\w])mod\\s+${name}\\s*[{;]`, "m").test(text.replace(/\/\/[^\n]*/g, ""));

export interface RustFacts {
  /** The text of the file the view goes into; undefined when it cannot be read. */
  source: string | undefined;
  /** `Cargo.toml` of the adapter root. */
  cargo: string | undefined;
  /** Some `.rs` file of the crate already invokes `paneweft::test_adapter!()`. */
  testAdapter: boolean;
}

function rustFiles(root: string, relative: string, found: string[]): void {
  if (found.length >= SCAN_FILES) return;
  let entries;
  try {
    entries = readdirSync(join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) rustFiles(root, join(relative, entry.name), found);
    else if (entry.name.endsWith(".rs")) found.push(join(relative, entry.name));
  }
}

export function rustFacts(adapter: AdapterRecord, sourcePath: string): RustFacts {
  const root = adapterRoot(adapter);
  const files: string[] = [];
  for (const directory of ["src", "tests"]) rustFiles(root, directory, files);
  return {
    source: readInside(root, sourcePath),
    cargo: readInside(root, "Cargo.toml"),
    testAdapter: files.some((file) => /test_adapter!\s*[(\[{]/.test(readInside(root, file) ?? "")),
  };
}

/** What `Cargo.toml` already wires: the feature, the dependency, and whether a `[features]` table exists to merge into. */
export function cargoWiring(cargo: string | undefined): { feature: boolean; dependency: boolean; featuresTable: boolean } {
  const text = (cargo ?? "").replace(/#[^\n]*/g, "");
  return {
    feature: /^\s*paneweft\s*=\s*\[/m.test(text),
    dependency: /^\s*\[dependencies\.paneweft\]/m.test(text) || /^\s*paneweft\s*=\s*\{/m.test(text),
    featuresTable: /^\s*\[features\]/m.test(text),
  };
}

export interface TypeScriptFacts {
  /** `@paneweft/sdk` is declared in package.json or installed in node_modules. */
  sdkInstalled: boolean;
  /** `paneweft.views.ts` exists at the adapter root. */
  manifest: boolean;
  /** The vitest config file exists, and whether it names the paneweft reporter. */
  config: { path: string; exists: boolean; reporter: boolean };
}

export function typeScriptFacts(adapter: AdapterRecord): TypeScriptFacts {
  const root = adapterRoot(adapter);
  const packageText = readInside(root, "package.json") ?? "";
  const configPath = adapter.vitestConfig ?? "vitest.config.ts";
  const config = readInside(root, configPath);
  return {
    sdkInstalled: /"@paneweft\/sdk"\s*:/.test(packageText) || existsSync(join(root, "node_modules/@paneweft/sdk")),
    manifest: existsSync(join(root, "paneweft.views.ts")),
    config: { path: configPath, exists: config !== undefined, reporter: config !== undefined && /@paneweft\/sdk\/vitest-reporter|vitest-reporter(\.ts)?["']/.test(config) },
  };
}

/** `slug` for identifiers: lowercase words joined by `_`, cut at a word boundary (never mid-word) within `max` characters. */
export function wordSlug(text: string, max: number, fallback = "view"): string {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length + word.length + (kept.length === 0 ? 0 : 1);
    if (next > max) break;
    kept.push(word);
    length = next;
  }
  const joined = kept.join("_");
  return joined === "" ? fallback : /^[0-9]/.test(joined) ? `${fallback}_${joined}` : joined;
}

/** A title of at most `max` characters, cut at a word boundary, without the trailing question mark. */
export function wordTitle(text: string, max: number): string {
  const trimmed = text.trim().replace(/\?+$/, "").trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : trimmed.slice(0, max)).replace(/[\s,;:-]+$/, "");
}
