// Stored pages: the rows of a captured list beyond the first page live in content-addressed page files (spec section 4, "lazy children").
// The stored v0 envelope carries only the first page, so a reader that stops there never sees the rest. `withStoredPages` puts the rows of
// every stored page back, in order, for the readers that serve a view to a person or an agent (the view_result tool, the viewer), and
// states honestly what it could not read. Nothing here executes code; the pages are files the import wrote.
import type { Envelope } from "../core/wire.ts";
import type { Session } from "../core/session.ts";
import type { ObjectGraph, PageRecord } from "../generated/v1/ObjectGraph.ts";
import { lowerCompleteness, lowerListRows } from "./capture.ts";
import { captureFile, committedImport, pageFile, readJsonFile } from "./read.ts";

/** `envelope` with the rows of its stored pages appended to `data.rows`, and the completeness recomputed from what is now present.
 * An envelope that is not a stored v1 list, or that has no stored pages, is returned as it is. A page that cannot be read leaves the
 * gap standing, with the reason. */
export async function withStoredPages(session: Session, envelope: Envelope): Promise<Envelope> {
  if (envelope.component !== "list" || !envelope.snapshotId.startsWith("snap-")) return envelope;
  const runId = envelope.snapshotId.slice("snap-".length);
  const dot = envelope.entity.id.lastIndexOf(".");
  if (runId.length === 0 || dot <= 0) return envelope;
  const record = await committedImport(session, runId);
  if (record === undefined) return envelope;
  const captureId = envelope.entity.id.slice(0, dot);
  const objectId = envelope.entity.id.slice(dot + 1);
  if (!record.captureIds.includes(captureId)) return envelope;
  const graph = await readJsonFile<ObjectGraph>(captureFile(session, runId, captureId));
  const view = graph?.views.find((candidate) => candidate.objectId === objectId && candidate.viewId === envelope.viewDefinitionId);
  if (graph === undefined || view === undefined || view.pages.length === 0) return envelope;
  const rows: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  for (const reference of [...view.pages].sort((a, b) => a.index - b.index)) {
    const page = await readJsonFile<PageRecord>(pageFile(session, reference.pageId)).catch(() => undefined);
    if (page === undefined || page.pageId !== reference.pageId) missing.push(reference.pageId);
    else rows.push(...lowerListRows(graph, record.repo, page.rows as Array<Record<string, unknown>>));
  }
  const data = envelope.data as unknown as { rows: Array<Record<string, unknown>> } & Record<string, unknown>;
  if (missing.length > 0) {
    const stored = view.pages.reduce((sum, page) => sum + page.rowCount, 0);
    return { ...envelope, data: { ...data, rows: [...data.rows, ...rows] }, completeness: { status: "partial", gaps: [{ id: "stored-pages", question: "Where are the remaining rows?", reason: `${stored} rows are stored in ${view.pages.length} page(s), but ${missing.length} could not be read: ${missing.join(", ")}`.slice(0, 1000) }] } } as unknown as Envelope;
  }
  // every page is back: the completeness is that of the view itself, without the gap the missing pages made
  return { ...envelope, data: { ...data, rows: [...data.rows, ...rows] }, completeness: lowerCompleteness({ ...view, pages: [] }) } as unknown as Envelope;
}
