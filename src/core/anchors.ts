// Source anchors resolve only inside registered repository roots (design section 5).
// CLAIM(anchor-roots): canonicalised path stays inside the canonicalised root; `..`, absolute
//   paths, NUL bytes and symlinks leaving the root are rejected [design section 5; anchors.test.ts, MC6, MC15].
import type { Anchor } from "./wire.ts";
import type { RepositoryRegistration } from "./session.ts";
import { notImplementedResult, type Result } from "./errors.ts";

export interface NumberedLine { n: number; text: string }
export interface ResolvedAnchor {
  repository: string;
  relativePath: string;
  lines: [number, number];
  numberedLines: NumberedLine[];
  /** sha256 of the whole file's current bytes */
  fileSha256: string;
}

/** STUB. Errors: PATH_OUTSIDE_ROOT, INVALID_PATH, REPOSITORY_NOT_REGISTERED, NOT_FOUND, LINES_OUT_OF_RANGE. */
export async function resolveSourceAnchor(_repositories: RepositoryRegistration[], _anchor: Anchor): Promise<Result<ResolvedAnchor>> {
  return notImplementedResult("resolveSourceAnchor");
}
