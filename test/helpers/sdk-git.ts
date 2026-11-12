// The SDK is a git dependency on the public repository (F3). Tests must not need the network, and must build the commit THIS checkout pins, so the GitHub URL is
// redirected at the transport level (git's `url.<base>.insteadOf`, honoured because cargo is told to fetch with the git CLI) to a bare mirror of this repository.
// Manifests and lockfiles under test therefore contain the real URL and rev, exactly as a scaffold prints them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./fixtures.ts";
import { SDK_GIT_REV, SDK_GIT_URL } from "../../src/v1/sdk-source.ts";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The bare mirror of this repository, built once and shared by every test file (created beside the build output, replaced atomically so parallel workers agree). */
export function sdkMirror(): string {
  const mirror = join(REPO_ROOT, "target", "sdk-mirror.git");
  const has = () => { try { git(mirror, ["cat-file", "-e", `${SDK_GIT_REV}^{commit}`]); return true; } catch { return false; } };
  if (existsSync(mirror) && has()) return mirror;
  mkdirSync(join(REPO_ROOT, "target"), { recursive: true });
  const staging = `${mirror}.${process.pid}.${Date.now()}`;
  git(REPO_ROOT, ["clone", "--bare", "--quiet", REPO_ROOT, staging]);
  try {
    rmSync(mirror, { recursive: true, force: true });
    renameSync(staging, mirror);
  } catch {
    rmSync(staging, { recursive: true, force: true }); // another worker won the race
  }
  // a shallow clone or a rewritten history lacks the pinned commit: say so, never skip the tests that need it
  if (!has()) throw new Error(`this checkout does not contain the SDK commit ${SDK_GIT_REV} that src/v1/sdk-source.ts pins: fetch full history (git fetch --unshallow) or bump the pin`);
  return mirror;
}

/** Environment for a cargo run that must resolve `SDK_GIT_URL` from the local mirror. */
export function sdkGitEnv(): Record<string, string> {
  return {
    CARGO_NET_GIT_FETCH_WITH_CLI: "true",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${sdkMirror()}.insteadOf`,
    GIT_CONFIG_VALUE_0: SDK_GIT_URL,
  };
}
