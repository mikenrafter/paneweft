#!/usr/bin/env node
// A stand-in for a rustup `cargo` proxy (field test F21): without RUSTUP_HOME it refuses exactly as rustup does when no default toolchain is configured, and with it
// it behaves as the fake cargo. The registered cargo of the field test was /usr/local/cargo/bin/cargo, a proxy that needs RUSTUP_HOME; a fake that needs nothing hid the failure.
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.RUSTUP_HOME === undefined || process.env.RUSTUP_HOME === "") {
  console.error("error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.");
  process.exit(1);
}
const fake = fileURLToPath(new URL("./fake-cargo.mjs", import.meta.url));
chmodSync(fake, 0o755);
const result = spawnSync(process.execPath, [fake, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
