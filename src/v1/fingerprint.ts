// Input fingerprints and freshness (spec section 6; amendments S10, N5; IV18).
//
// Members = tracked files + untracked non-ignored files under the root (N5) + declared extras - explicit exclusions. The digest is the
// sha256 over the sorted lines `<path>\0<sha256>\n`. Before/after hashing is a SAMPLE (S10): it cannot see an edit that was made and
// restored between the two samples, and its wording says so.
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "../core/digest.ts";
import { compareCodeUnits } from "../core/canonical.ts";
import { err, ok, type Result } from "../core/errors.ts";

const run = promisify(execFile);

export interface FingerprintOptions {
  /** The crate or package root. */
  root: string;
  /** Extra inputs outside the root (lockfiles, fixtures), relative to the root's repository or absolute inside it. */
  declaredExtras?: string[];
  /** Explicit exclusions (relative paths or directory prefixes) applied to tracked and untracked members alike. */
  exclusions?: string[];
}

export interface Fingerprint {
  /** sha256 over the sorted (path, sha256) member list. */
  digest: string;
  members: Array<{ path: string; sha256: string }>;
  declaredExtras: string[];
  exclusions: string[];
}

export type FileChange = { path: string; change: "modified" | "added" | "deleted" };

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await run("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout.split("\0").filter((line) => line.length > 0);
}

async function hashFile(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return undefined;
    return sha256Hex(await readFile(path));
  } catch {
    return undefined;
  }
}

const excluded = (path: string, exclusions: string[]): boolean => exclusions.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/+$/, "")}/`));

/** Members = `git ls-files` under the root + `git ls-files --others --exclude-standard` (N5) + declared extras - exclusions. */
export async function computeFingerprint(options: FingerprintOptions): Promise<Result<Fingerprint>> {
  const root = resolve(options.root);
  const declaredExtras = [...(options.declaredExtras ?? [])];
  const exclusions = [...(options.exclusions ?? [])];
  let top: string;
  let names: string[];
  try {
    top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" })).stdout.trim();
    names = [...new Set([...(await gitLines(root, ["ls-files", "-z"])), ...(await gitLines(root, ["ls-files", "-z", "--others", "--exclude-standard"]))])];
  } catch (cause) {
    return err("INVALID_PATH", `"${root}" is not inside a git work tree, so its inputs cannot be listed; freshness stays unverified`, { details: { cause: cause instanceof Error ? cause.message : String(cause) } });
  }
  const candidates = new Map<string, string>();
  for (const name of names) candidates.set(name, join(root, name));
  for (const extra of declaredExtras) {
    const absolute = isAbsolute(extra) ? extra : join(top, extra);
    const fromTop = relative(top, absolute);
    if (fromTop.startsWith("..") || isAbsolute(fromTop)) return err("PATH_OUTSIDE_ROOT", `the declared extra input "${extra}" is outside the repository "${top}"`);
    const path = relative(root, absolute).split(sep).join("/");
    candidates.set(path, absolute);
  }
  const members: Fingerprint["members"] = [];
  for (const [path, absolute] of [...candidates.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (excluded(path, exclusions)) continue;
    const hash = await hashFile(absolute);
    if (hash !== undefined) members.push({ path, sha256: hash });
  }
  return ok({ digest: sha256Hex(members.map((member) => `${member.path}\0${member.sha256}\n`).join("")), members, declaredExtras, exclusions });
}

function changes(before: Fingerprint, after: Fingerprint): FileChange[] {
  const left = new Map(before.members.map((member) => [member.path, member.sha256]));
  const right = new Map(after.members.map((member) => [member.path, member.sha256]));
  const result: FileChange[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort(compareCodeUnits)) {
    const was = left.get(path);
    const now = right.get(path);
    if (was === undefined) result.push({ path, change: "added" });
    else if (now === undefined) result.push({ path, change: "deleted" });
    else if (was !== now) result.push({ path, change: "modified" });
  }
  return result;
}

/** Before/after hashing is a SAMPLE: it detects a file that differs at the two sample points, not an edit that was made and
 * restored in between (S10). The wording of `note` says so. */
export function sampleConsistency(before: Fingerprint, after: Fingerprint): { status: "consistent-sampled" | "mixed-input"; changed: FileChange[]; note: string } {
  const changed = changes(before, after);
  if (changed.length > 0) {
    const shown = changed.slice(0, 5).map((change) => `${change.path} (${change.change})`).join(", ");
    return { status: "mixed-input", changed, note: `Mixed input: ${changed.length} member(s) differ between the sample taken before the run and the sample taken after it (${shown}${changed.length > 5 ? ", ..." : ""}); the run observed a changing checkout and is not fit to be marked fresh.` };
  }
  return { status: "consistent-sampled", changed: [], note: "Sampled consistency: the member hashes were equal in the sample before the run and the sample after it. Two samples are not proof about the time in between: an edit made and then restored between them is undetectable." };
}

/** Freshness of a captured fingerprint against the current one. A recompile alone never refreshes a result: only equal members do. */
export function compareFingerprints(captured: Fingerprint, current: Fingerprint): { status: "fresh" | "stale"; reasons: FileChange[] } {
  const reasons = changes(captured, current);
  return { status: reasons.length === 0 ? "fresh" : "stale", reasons };
}
