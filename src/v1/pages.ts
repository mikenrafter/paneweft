// Stored pages: the rows of a captured list beyond the first page live in content-addressed page files (spec section 4, "lazy children").
// The stored v0 envelope carries only the first page, so a reader that stops there never sees the rest. `withStoredPages` puts the rows of
// every stored page back, in order, for the readers that serve a view to a person or an agent (the view_result tool, the viewer), and
// states honestly what it could not read. Nothing here executes code; the pages are files the import wrote.
import { err, ok, type Result } from "../core/errors.ts";
import type { Envelope } from "../core/wire.ts";
import type { Session } from "../core/session.ts";
import type { ObjectGraph, PageRecord } from "../generated/v1/ObjectGraph.ts";
import { lowerCompleteness, lowerListRows } from "./capture.ts";
import { checkListRows, checkPageRecord, rowIds } from "./page-rows.ts";
import { captureFile, committedImport, pageFile, readJsonFile } from "./read.ts";

/** `envelope` with the rows of its stored pages appended to `data.rows`, and the completeness recomputed from what is now present.
 * An envelope that is not a stored v1 list, or that has no stored pages, is returned as it is. A page that cannot be read leaves the
 * gap standing, with the reason. A page that IS there but is not a valid page of this view (S22: wrong rows, wrong place, a hash that is not
 * its id, a row the list does not accept) is an error naming it, never a throw and never rows the reader made up its mind to believe. */
export async function withStoredPages(session: Session, envelope: Envelope): Promise<Result<Envelope>> {
  if (envelope.component !== "list" || !envelope.snapshotId.startsWith("snap-")) return ok(envelope);
  const runId = envelope.snapshotId.slice("snap-".length);
  const dot = envelope.entity.id.lastIndexOf(".");
  if (runId.length === 0 || dot <= 0) return ok(envelope);
  const record = await committedImport(session, runId);
  if (record === undefined) return ok(envelope);
  const captureId = envelope.entity.id.slice(0, dot);
  const objectId = envelope.entity.id.slice(dot + 1);
  if (!record.captureIds.includes(captureId)) return ok(envelope);
  const graph = await readJsonFile<ObjectGraph>(captureFile(session, runId, captureId));
  const view = graph?.views.find((candidate) => candidate.objectId === objectId && candidate.viewId === envelope.viewDefinitionId);
  if (graph === undefined || view === undefined || view.pages.length === 0) return ok(envelope);
  const data = envelope.data as unknown as { rows: Array<Record<string, unknown>> } & Record<string, unknown>;
  const rows: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>(rowIds(data.rows));
  for (const reference of [...view.pages].sort((a, b) => a.index - b.index)) {
    const page = await readJsonFile<PageRecord>(pageFile(session, reference.pageId)).catch(() => undefined);
    if (page === undefined) {
      missing.push(reference.pageId);
      continue;
    }
    const reasons = checkPageRecord(page, { pageId: reference.pageId, viewId: view.viewId, objectId: view.objectId, index: reference.index, rowCount: reference.rowCount });
    if (reasons.length === 0) {
      reasons.push(...checkListRows(data as { columns?: unknown; order?: unknown }, page.rows, "/rows", seen).slice(0, 3).map((fault) => `${fault.pointer} ${fault.constraint}`));
      for (const [position, row] of (page.rows as Array<{ target?: { object?: string } }>).entries()) {
        const target = row?.target?.object;
        if (target !== undefined && !graph.objects.some((object) => object.id === target)) reasons.push(`/rows/${position}/target names the object ${JSON.stringify(target)}, which the capture does not hold`);
      }
    }
    if (reasons.length > 0) {
      invalid.push(`${reference.pageId}: ${reasons.join("; ")}`);
      continue;
    }
    rows.push(...lowerListRows(graph, record.repo, page.rows as Array<Record<string, unknown>>));
  }
  if (invalid.length > 0) return err("STORAGE_CORRUPT", `the stored page${invalid.length === 1 ? "" : "s"} of view "${envelope.viewDefinitionId}" in run "${runId}" ${invalid.length === 1 ? "is" : "are"} not valid: ${invalid.join(" | ")}`.slice(0, 2000), { details: { runId, view: envelope.viewDefinitionId, pages: invalid } });
  if (missing.length > 0) {
    const stored = view.pages.reduce((sum, page) => sum + page.rowCount, 0);
    return ok({ ...envelope, data: { ...data, rows: [...data.rows, ...rows] }, completeness: { status: "partial", gaps: [{ id: "stored-pages", question: "Where are the remaining rows?", reason: `${stored} rows are stored in ${view.pages.length} page(s), but ${missing.length} could not be read: ${missing.join(", ")}`.slice(0, 1000) }] } } as unknown as Envelope);
  }
  // every page is back: the completeness is that of the view itself, without the gap the missing pages made
  return ok({ ...envelope, data: { ...data, rows: [...data.rows, ...rows] }, completeness: lowerCompleteness({ ...view, pages: [] }) } as unknown as Envelope);
}
