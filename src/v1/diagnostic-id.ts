// Diagnostic ids are numbered per collection (`diag-inv-1`, `diag-compile-1`, `diag-registration-1`), so two runs hold the same bare id. What a
// reply hands out is therefore qualified by its run: `<runId>:<id>` (S13). Lookup accepts the qualified form; a bare id is answered only when one run holds it.
export const qualifyDiagnosticId = (runId: string, id: string): string => `${runId}:${id}`;

/** The run and the in-run id of a qualified id; `runId` is null for a bare id. */
export function splitDiagnosticId(id: string): { runId: string | null; id: string } {
  const at = id.indexOf(":");
  return at > 0 && id.startsWith("run-") ? { runId: id.slice(0, at), id: id.slice(at + 1) } : { runId: null, id };
}
