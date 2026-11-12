// The compile errors of an export or a run, as diagnostics (F6): at most 20 listed, a count of the rest, and a next action that fits where the error is.
// An error in the paneweft SDK or in a file outside the repository root is not in the view source, and sending the reader to "the view source" wastes the
// round: the first says the SDK or its configuration is at fault, the second names the root. Pure: it reads text.
import { isAbsolute, normalize, relative } from "node:path";
import type { Diagnostic } from "../generated/v1/ObjectGraph.ts";

export const MAX_LISTED_COMPILE_ERRORS = 20;
type Where = "repository" | "sdk" | "outside";
interface Found { message: string; path: string; line: number; column: number }

/** A path that belongs to the paneweft SDK wherever it was copied or linked to (the package, a vendored copy, the crates, an installed package). */
const SDK_PATH = /(^|\/)(packages\/paneweft-ts|vendor\/paneweft|crates\/paneweft(-macros)?|node_modules\/@paneweft\/sdk)(\/|$)/;

function whereIs(path: string, root: string): Where {
  const unix = path.replaceAll("\\", "/");
  if (SDK_PATH.test(unix)) return "sdk";
  const inside = relative(root, isAbsolute(unix) ? normalize(unix) : normalize(`${root}/${unix}`));
  return inside === ".." || inside.startsWith("../") || isAbsolute(inside) ? "outside" : "repository";
}

const NEXT: Record<Where, string> = {
  repository: "Fix the named property or type in the view source, then run the collection again.",
  sdk: "This error is in the paneweft SDK, not in the view source: the SDK version does not fit the host, or the repository's compiler settings do not suit it. Align the SDK with the host (or the settings with the SDK), then run the collection again.",
  outside: "This error is in a file outside the repository root, so it is not in the instrumentation. Fix it there, or exclude it from what the collection typechecks (the adapter's tsconfig), then run the collection again.",
};

/** F5: a TypeScript error in a repository file may be in code the instrumentation never imports; the owner can scope the typecheck with the adapter's tsconfig. */
function nextFor(where: Where, kind: "cargo" | "vitest"): string {
  if (where === "repository" && kind === "cargo") return "Fix the named field or type in the view source at the span, then run the collection again.";
  if (where === "repository") return `${NEXT.repository} If the file has nothing to do with the instrumentation, the owner scopes the typecheck: register the adapter with a \`tsconfig\` that extends the repository's and lists only what the instrumentation imports.`;
  return NEXT[where];
}

export function compileDiagnostics(input: { log: string; typecheck: { output: string } | undefined; kind: "cargo" | "vitest"; root: string }): Diagnostic[] {
  const { log, typecheck, kind, root } = input;
  const category = kind === "cargo" ? "compiler" : "typecheck";
  const found: Found[] = [];
  if (kind === "cargo") {
    const pattern = /error(?:\[(E\d+)\])?: ([^\n]+)\n\s*--> ([^:\n]+):(\d+):(\d+)/g;
    for (const match of log.matchAll(pattern)) found.push({ message: `${match[1] === undefined ? "" : `${match[1]}: `}${match[2]}`, path: match[3] as string, line: Number(match[4]), column: Number(match[5]) });
  } else if (typecheck !== undefined) {
    for (const line of typecheck.output.split("\n")) {
      const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
      if (match !== null) found.push({ message: `${match[4]}: ${match[5]}`, path: match[1] as string, line: Number(match[2]), column: Number(match[3]) });
    }
  }
  if (found.length === 0) return [{ id: "diag-compile-1", category, message: "the instrumentation did not compile", stderrSlice: (typecheck?.output ?? log).slice(-3500), nextAction: "Read the stderr slice; fix the first error, then run the collection again." } as Diagnostic];
  const listed = found.slice(0, MAX_LISTED_COMPILE_ERRORS).map((error, index): Diagnostic => ({ id: `diag-compile-${index + 1}`, category, message: error.message.slice(0, 2000), source: { path: error.path, line: error.line, column: error.column }, nextAction: nextFor(whereIs(error.path, root), kind) } as Diagnostic));
  if (found.length <= MAX_LISTED_COMPILE_ERRORS) return listed;
  const counts: Record<Where, number> = { repository: 0, sdk: 0, outside: 0 };
  for (const error of found) counts[whereIs(error.path, root)] += 1;
  const omitted = found.length - MAX_LISTED_COMPILE_ERRORS;
  return [...listed, { id: "diag-compile-omitted", category, message: `${omitted} more error(s) are not listed (${found.length} in total, the first ${MAX_LISTED_COMPILE_ERRORS} are): ${counts.repository} in the repository, ${counts.sdk} in the paneweft SDK, ${counts.outside} outside the repository root`, nextAction: "Fix the listed errors, or the cause the counts point at (many errors in one place usually have one cause), then run the collection again. The whole compiler output is in the job log: paneweft collection status <job> --log-cursor 0." } as Diagnostic];
}
