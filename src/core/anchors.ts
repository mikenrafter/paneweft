// Source anchors resolve only inside registered repository roots (design section 5).
// CLAIM(anchor-roots): canonicalised path stays inside the canonicalised root; `..`, absolute
//   paths, NUL bytes and symlinks leaving the root are rejected [design section 5; anchors.test.ts, MC6, MC15].
// The decision is made in two steps and neither echoes file content or the outside path in an error:
//   1. lexically (no filesystem access): empty, NUL, any backslash, absolute, or a `..` segment => INVALID_PATH;
//   2. canonically: realpath of the root and of the target; a target whose real path leaves the real root => PATH_OUTSIDE_ROOT.
// The file is then read from an open handle whose real path is verified inside the root (confined-read.ts, CLAIM(confined-read)),
// so a symlink swapped in for the file or an ancestor after the check cannot redirect the read.
import { isAbsolute } from "node:path";
import type { Anchor } from "./wire.ts";
import type { RepositoryRegistration } from "./session.ts";
import type { OperationError, Result } from "./errors.ts";
import { sha256Hex } from "./digest.ts";
import { MAX_CONFINED_FILE_BYTES, readConfinedFile, UNSUPPORTED_PLATFORM_MESSAGE } from "./confined-read.ts";

export { canonicalPathInside } from "./confined-read.ts";

export interface NumberedLine { n: number; text: string }
export interface ResolvedAnchor {
  repository: string;
  relativePath: string;
  lines: [number, number];
  numberedLines: NumberedLine[];
  /** sha256 of the whole file's current bytes */
  fileSha256: string;
}

const failure = (code: OperationError["code"], message: string): { ok: false; error: OperationError } => ({
  ok: false,
  error: { schemaVersion: "paneweft.error/1", code, message, errors: [], retryable: false },
});

/**
 * Lexical normalisation of a repository-relative path: segments joined by "/", `.` and empty segments dropped.
 * Returns null for anything that could leave the root or is not a plain relative path.
 */
export function normaliseRelativePath(path: string): string | null {
  if (path === "" || path.includes("\u0000") || path.includes("\\") || path.startsWith("/") || isAbsolute(path)) return null;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments.join("/");
}

/** Lines of a text file: terminators (\n, \r\n) excluded, no phantom line after a final terminator, empty file = no lines. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** Errors: PATH_OUTSIDE_ROOT, INVALID_PATH, REPOSITORY_NOT_REGISTERED, NOT_FOUND, LINES_OUT_OF_RANGE, UNSUPPORTED_PLATFORM (not Linux), FILE_TOO_LARGE (over 16 MiB). */
export async function resolveSourceAnchor(repositories: RepositoryRegistration[], anchor: Anchor): Promise<Result<ResolvedAnchor>> {
  const registration = repositories.find((candidate) => candidate.id === anchor.repository);
  if (registration === undefined) return failure("REPOSITORY_NOT_REGISTERED", `repository "${anchor.repository}" is not registered with this session`);
  const relativePath = normaliseRelativePath(anchor.path);
  if (relativePath === null) return failure("INVALID_PATH", "the anchor path must be a plain relative path inside the repository (no absolute path, backslash, NUL byte or .. segment)");
  const read = await readConfinedFile(registration.root, relativePath);
  if (!read.ok) {
    if (read.reason === "outside") return failure("PATH_OUTSIDE_ROOT", "the anchor path resolves outside the registered repository root");
    if (read.reason === "unsupported-platform") return failure("UNSUPPORTED_PLATFORM", UNSUPPORTED_PLATFORM_MESSAGE);
    if (read.reason === "too-large") return failure("FILE_TOO_LARGE", `"${relativePath}" is larger than ${MAX_CONFINED_FILE_BYTES} bytes, the most a source anchor reads`);
    return failure("NOT_FOUND", read.reason === "root-inaccessible" ? `the root of repository "${anchor.repository}" is not accessible` : `no file "${relativePath}" in repository "${anchor.repository}"`);
  }
  const bytes = read.bytes;
  const lines = splitLines(bytes.toString("utf8"));
  const [first, last] = anchor.lines;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > lines.length) {
    return failure("LINES_OUT_OF_RANGE", `lines ${first}-${last} are outside the file, which has ${lines.length} line${lines.length === 1 ? "" : "s"}`);
  }
  return {
    ok: true,
    value: {
      repository: anchor.repository,
      relativePath,
      lines: [first, last],
      numberedLines: lines.slice(first - 1, last).map((text, offset) => ({ n: first + offset, text })),
      fileSha256: sha256Hex(bytes),
    },
  };
}
