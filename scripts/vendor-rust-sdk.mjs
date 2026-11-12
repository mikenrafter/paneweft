#!/usr/bin/env node
// Copies the Rust SDK into a repository, so that the repository's optional `paneweft` dependency is a path INSIDE the repository (field test F3).
//
//   node scripts/vendor-rust-sdk.mjs <destination directory>        e.g. vendor/paneweft, relative to the repository you are instrumenting
//
// Why a copy: Cargo reads the manifest of every path dependency, optional ones included, whenever it resolves a package; a feature that is off does not excuse it. An optional path
// dependency that points at a checkout next to the repository (../../paneweft/crates/paneweft) makes every plain `cargo build`, `cargo metadata` and Nix build fail wherever that
// checkout is absent, so a release build would need the development tool. A path dependency inside the repository is always there, and a release build that leaves the feature off
// still compiles none of it (the crate stays out of the build graph; its few third-party dependencies are only in Cargo.lock).
//
// The copy is `paneweft` and `paneweft-macros` (src and a manifest with the workspace values written out and the dev-dependencies removed) and a VENDORED file naming where it came
// from and the digest of its contents. Running it again replaces the copy; do not edit it. In the repository's Cargo.toml:
//
//   [features]
//   paneweft = ["dep:paneweft"]
//   [dependencies.paneweft]
//   path = "<destination>/paneweft"
//   optional = true
//
// A Cargo workspace whose root holds the destination takes the two crates in as members: list them under `exclude`.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const destination = process.argv[2];
if (destination === undefined || destination.startsWith("-")) {
  console.error("usage: node scripts/vendor-rust-sdk.mjs <destination directory>");
  process.exit(64);
}

const workspace = readFileSync(join(root, "Cargo.toml"), "utf8");
const packageTable = /\[workspace\.package\]\n([\s\S]*?)(?=\n\[|$)/.exec(workspace)?.[1] ?? "";
const inherited = (key) => {
  const value = new RegExp(`^${key}\\s*=\\s*(.+)$`, "m").exec(packageTable)?.[1];
  if (value === undefined) throw new Error(`Cargo.toml has no [workspace.package] ${key}`);
  return value.trim();
};

/** The manifest of a workspace member as a standalone one: inherited keys written out, dev-dependencies (tests, which are not copied) removed. */
function standalone(manifest) {
  let text = manifest.replace(/^(version|edition|publish|license)\.workspace\s*=\s*true$/gm, (_, key) => `${key} = ${inherited(key)}`);
  text = text.replace(/\n\[dev-dependencies\][\s\S]*?(?=\n\[|$)/g, "");
  return `${text.trimEnd()}\n`;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])).sort();
}

const target = resolve(process.cwd(), destination);
mkdirSync(target, { recursive: true });
for (const name of ["paneweft", "paneweft-macros"]) {
  const from = join(root, "crates", name);
  const to = join(target, name);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(join(from, "src"), join(to, "src"), { recursive: true });
  writeFileSync(join(to, "Cargo.toml"), standalone(readFileSync(join(from, "Cargo.toml"), "utf8")));
}
const digest = createHash("sha256");
for (const name of ["paneweft", "paneweft-macros"]) for (const file of files(join(target, name))) digest.update(`${relative(target, file)}\0`).update(readFileSync(file));
const commit = (() => { try { return readFileSync(join(root, ".git/HEAD"), "utf8").trim(); } catch { return "unknown"; } })();
writeFileSync(join(target, "VENDORED"), `Copied by paneweft scripts/vendor-rust-sdk.mjs from ${root} (${commit}).\nsha256 ${digest.digest("hex")}\nDo not edit: run the script again to replace this copy.\n`);
console.log(`vendored the paneweft Rust SDK into ${target} (${existsSync(join(target, "VENDORED")) && statSync(join(target, "VENDORED")).size} byte record)`);
