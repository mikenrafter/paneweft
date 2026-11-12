// Stored pages: the rows of a captured list beyond the first page live in content-addressed page bodies (spec section 4, "lazy children"; D2),
// owned by the references of the run that imported them. The stored v0 envelope carries only the first page, so a reader that stops there never
// sees the rest. `withStoredPages` puts the rows of every stored page back, in order, for the readers that serve a view to a person or an agent
// (the view_result tool, the viewer), through the one validated page reader (`readPageAt`, D3), and states honestly what it could not read.
// Nothing here executes code; the pages are files the import wrote.
import { err, ok, type Result } from "../core/errors.ts";
import type { Envelope } from "../core/wire.ts";
import type { Session } from "../core/session.ts";
import { lowerCompleteness, lowerListRows } from "./capture.ts";
import { rowIds } from "./page-rows.ts";
import { loadViewPages, readPageAt } from "./read.ts";

/** `envelope` with the rows of its stored pages appended to `data.rows`, and the completeness recomputed from what is now present.
 * An envelope that is not a stored v1 list, or that has no stored pages, is returned as it is. A page that is not there leaves the gap standing,
 * with the reason (NOT_FOUND on the reader). A page that IS there but is not a valid page of this view (STORAGE_CORRUPT on the reader: not JSON,
 * the wrong shape, a hash that is not its id, a row the list does not accept) is an error naming it, never a throw and never rows the reader made
 * up its mind to believe. */
export async function withStoredPages(session: Session, envelope: Envelope): Promise<Result<Envelope>> {
  if (envelope.component !== "list" || !envelope.snapshotId.startsWith("snap-")) return ok(envelope);
  const runId = envelope.snapshotId.slice("snap-".length);
  const dot = envelope.entity.id.lastIndexOf(".");
  if (runId.length === 0 || dot <= 0) return ok(envelope);
  const captureId = envelope.entity.id.slice(0, dot);
  const objectId = envelope.entity.id.slice(dot + 1);
  const loaded = await loadViewPages(session, { runId, captureId, objectId, viewId: envelope.viewDefinitionId });
  if (!loaded.ok) return loaded.error.code === "NOT_FOUND" ? ok(envelope) : loaded;
  const { view, graph, record, refs } = loaded.value;
  if (refs.length === 0) return ok(envelope);
  const data = envelope.data as unknown as { rows: Array<Record<string, unknown>> } & Record<string, unknown>;
  const rows: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>(rowIds(data.rows));
  for (const ref of refs) {
    const page = await readPageAt(loaded.value, ref.position, seen);
    if (page.ok) {
      rows.push(...lowerListRows(graph, record.repo, page.value.rows));
    } else if (page.error.code === "NOT_FOUND") {
      missing.push(ref.pageId);
    } else if (page.error.code === "STORAGE_CORRUPT") {
      invalid.push(`${ref.pageId}: ${(page.error.details?.reasons as string[] | undefined)?.join("; ") ?? page.error.message}`);
    } else {
      return page;
    }
  }
  if (invalid.length > 0) return err("STORAGE_CORRUPT", `the stored page${invalid.length === 1 ? "" : "s"} of view "${envelope.viewDefinitionId}" in run "${runId}" ${invalid.length === 1 ? "is" : "are"} not valid: ${invalid.join(" | ")}`.slice(0, 2000), { details: { runId, view: envelope.viewDefinitionId, pages: invalid } });
  if (missing.length > 0) {
    const stored = refs.reduce((sum, ref) => sum + ref.rowCount, 0);
    return ok({ ...envelope, data: { ...data, rows: [...data.rows, ...rows] }, completeness: { status: "partial", gaps: [{ id: "stored-pages", question: "Where are the remaining rows?", reason: `${stored} rows are stored in ${refs.length} page(s), but ${missing.length} could not be read: ${missing.join(", ")}`.slice(0, 1000) }] } } as unknown as Envelope);
  }
  // every page is back: the completeness is that of the view itself, without the gap the missing pages made
  return ok({ ...envelope, data: { ...data, rows: [...data.rows, ...rows] }, completeness: lowerCompleteness({ ...view, pages: [] }) } as unknown as Envelope);
}
