// Where an instrumented Rust repository gets the paneweft SDK from (F3). The SDK is a rev-pinned git dependency on the public repository: a path to a
// checkout next to the repository breaks every plain build where the checkout is absent (Cargo reads optional path dependencies with the feature off), and a
// copy inside the repository goes stale. A git dependency resolves the same way on every machine that can reach the remote, and `cargo vendor` / Nix's
// `importCargoLock` know how to carry it offline.

/** The public repository the SDK crates (`crates/paneweft`, `crates/paneweft-macros`) are published from. */
export const SDK_GIT_URL = "https://github.com/mikenrafter/paneweft";

/**
 * The commit of `SDK_GIT_URL` that scaffolds and docs pin. Rev policy:
 * - a full 40-hex commit, never a branch or tag name: the build is the same on every machine and every day;
 * - the commit must be reachable from a branch or tag on the remote that is not force-pushed away (GitHub drops unreachable commits);
 * - it is the newest commit whose `crates/` equal this checkout's (`sdk-source.test.ts` fails when they differ). Change the SDK, push, then bump this
 *   constant, the three docs that quote it and nothing else; instrumented repositories bump with
 *   `cargo update -p paneweft --precise <sha>` after editing `rev`.
 */
export const SDK_GIT_REV = "cb01e0e9f7f71b413a00e8851d852b70f37d4dad";

/** The `Cargo.toml` text of the optional dependency, as every doc and scaffold writes it. */
export const sdkDependencyToml = (): string[] => ["[dependencies.paneweft]", `git = "${SDK_GIT_URL}"`, `rev = "${SDK_GIT_REV}"`, "optional = true"];

export type SdkDependencySource =
  | { kind: "none" }
  | { kind: "path"; path: string }
  | { kind: "git"; url: string; rev: string | undefined }
  | { kind: "other" };

/** How `Cargo.toml` declares the `paneweft` dependency, for the table form (`[dependencies.paneweft]`) and the inline form (`paneweft = { ... }`). */
export function sdkDependencySource(cargo: string | undefined): SdkDependencySource {
  const text = (cargo ?? "").replace(/#[^\n]*/g, "");
  const table = /^\s*\[(?:\w+\.)?dependencies\.paneweft\]\s*\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text)?.[1];
  const inline = /^\s*paneweft\s*=\s*\{([^}]*)\}/m.exec(text)?.[1];
  const body = table ?? inline;
  if (body === undefined) return { kind: "none" };
  const field = (name: string) => new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*"([^"]*)"`, "m").exec(body)?.[1];
  const git = field("git");
  if (git !== undefined) return { kind: "git", url: git, rev: field("rev") };
  const path = field("path");
  return path !== undefined ? { kind: "path", path } : { kind: "other" };
}
