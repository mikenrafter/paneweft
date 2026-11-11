// The shared operation layer. CLI and MCP are thin adapters over executeOperation, which is
// how "CLI and MCP produce the same error codes and summary contents" (design section 5) holds
// by construction; MC11 proves it against literal bytes as well.
//
// Reason: one place owns argument validation, bounded summaries, cursors and error mapping.
// Errors: never throws; failures are `{ok:false}` outcomes carrying an OperationError.
// Invariants:
//   - `body` is the whole serialized business reply; Buffer.byteLength(body) <= maxBytes (MC3).
//   - A reply header always states question, completeness, freshness, snapshot, provenance (MC4, MC5).
//   - `args` are validated against src/schemas/tools/<name>.schema.json. maxBytes < 2048 is
//     BUDGET_TOO_SMALL (minimumBytes 2048); other argument faults are INVALID_ARGUMENT with a pointer.
// Mating parts: src/cli/main.ts, src/mcp/server.ts.
//
// CLAIM(bounded-exit): every outcome leaves through `enforceReplyBudget` in executeOperation, so no producer (failure serializer, echoed input,
//   unpaged success) can exceed the request's byte budget [reply-budget.ts; operations.exit-budget.test.ts, review S3].
// CLAIM(operation-order): unknown tool, then SESSION_REQUIRED, then argument validation, then the target lookup, then the budget check,
//   so the first thing wrong is the thing reported [operations.discovery.test.ts, MC11].
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Entity, EntityRef, Envelope } from "./wire.ts";
import type { OperationError, ValidationIssue } from "./errors.ts";
import { SessionStorageError, type Session, type SessionReader, type ViewCompleteness, type ViewKey } from "./session.ts";
import { TOOL_NAMES } from "../schemas/index.ts";
import { validateAgainstOwnerSchema, validateSubmission, validateToolArguments, type ValidationNote } from "./validate.ts";
import { COMPONENT_CATALOGUE } from "./catalogue.ts";
import { COMPONENT_EXAMPLES } from "./examples.ts";
import { LIMITS } from "./limits.ts";
import { checkFreshness } from "./freshness.ts";
import { rankViews, type RankOutput } from "./registry.ts";
import { resolveItemSource } from "./links.ts";
import { readEffectiveView } from "./example-runs.ts";
import { referencedSnapshot, viewItems, type AnyItem } from "./items.ts";
import { decodeCursor, encodeCursor, queryDigest } from "./cursor.ts";
import { fragmentSource, minimumBytes, paginate, type Entry, type Format, type Layout, type PageState } from "./pager.ts";
import { layoutOf, summariseView, QueryError, type EmbedInfo, type ReplyExtras, type ViewFilter, type ViewOrder, type ViewQuery, type ViewSummary } from "./summaries.ts";
import { loadSchemaDocuments, type ComponentId } from "../schemas/index.ts";
import { compareCodeUnits } from "./canonical.ts";
import { searchSession } from "./search.ts";
import { boundError, boundSuccessBody, byteLength, replyBudget } from "./reply-budget.ts";

export type ReplyFormat = "text" | "json";

export type OperationOutcome =
  | { ok: true; format: ReplyFormat; body: string; payload: unknown; cursor: string | null }
  | { ok: false; format: ReplyFormat; body: string; error: OperationError };

// ---- outcomes ----------------------------------------------------------------------------------------------------------

function failed(format: ReplyFormat, code: OperationError["code"], message: string, extra: { errors?: ValidationIssue[]; retryable?: boolean; details?: Record<string, unknown> } = {}): OperationOutcome {
  const error: OperationError = {
    schemaVersion: "paneweft.error/1",
    code,
    message,
    errors: extra.errors ?? [],
    retryable: extra.retryable ?? false,
    ...(extra.details === undefined ? {} : { details: extra.details }),
  };
  return { ok: false, format, body: JSON.stringify(error), error };
}
const failedFrom = (format: ReplyFormat, error: OperationError, errorPrefix = ""): OperationOutcome => {
  const prefixed: OperationError = errorPrefix === "" ? error : { ...error, errors: error.errors.map((issue) => ({ ...issue, pointer: `${errorPrefix}${issue.pointer}` })) };
  return { ok: false, format, body: JSON.stringify(prefixed), error: prefixed };
};
const unresolved = (format: ReplyFormat, message: string): OperationOutcome => failed(format, "UNRESOLVED_TARGET", message);

interface Context { format: ReplyFormat; budget: number; cursor: string | undefined }

function cursorIssue(code: string, constraint: string, hint: string): ValidationIssue {
  return { code: "CONSTRAINT", pointer: "/cursor", constraint: `${code}: ${constraint}`, hint };
}

// ---- serving a layout ----------------------------------------------------------------------------------------------------

/** Pages `layout` from the cursor in `context` (or the start) within the budget; the single exit of every paged operation. */
function serve(unbound: Layout, query: string, context: Context): OperationOutcome {
  const { format, budget } = context;
  // CLAIM(cursor-content-bound): every cursor issued here carries a digest of this listing's entries, checked when it comes back
  const content = queryDigest(unbound.entries.map((entry) => [entry.kind, entry.id, entry.countable, entry.text, entry.json])).slice(0, 8);
  const layout: Layout = { ...unbound, cursorAt: (index, offset, cursorFormat) => encodeCursor(query, { index, offset, ...(offset > 0 ? { format: cursorFormat } : {}) }, content) };
  const minimum = minimumBytes(layout, format);
  if (budget < minimum) {
    return failed(format, "BUDGET_TOO_SMALL", `maxBytes ${budget} is below the ${minimum} bytes needed for the mandatory part of this reply`, { details: { minimumBytes: minimum } });
  }
  let start = { index: 0, offset: 0 };
  if (context.cursor !== undefined) {
    const decoded = decodeCursor(context.cursor);
    if (!decoded.ok) return failed(format, "CURSOR_INVALID", "the cursor is not a cursor this server issued", { errors: [cursorIssue("CURSOR_INVALID", "an unmodified cursor", "Pass the cursor of the previous reply unchanged, or omit it to start from the beginning.")] });
    if (decoded.query !== query) return failed(format, "CURSOR_MISMATCH", "the cursor belongs to a different query (view, snapshot, filter, order or target)", { errors: [cursorIssue("CURSOR_MISMATCH", "the query that issued the cursor", "Repeat the original request with the cursor, or drop the cursor to start the new query.")] });
    if (decoded.content !== content) return failed(format, "CURSOR_STALE", "the listing changed since this cursor was issued (its content is no longer the one that was paged); repeat the request without a cursor", { errors: [cursorIssue("CURSOR_STALE", "the listing the cursor was issued for", "Repeat the request without a cursor to read the current listing from the start.")] });
    const { index, offset, format: cursorFormat } = decoded.position;
    const entry = layout.entries[index];
    const valid = index <= layout.entries.length && (offset === 0 || (entry !== undefined && cursorFormat === format && offset < Buffer.byteLength(fragmentSource(entry, format), "utf8")));
    if (!valid) {
      if (offset > 0 && cursorFormat !== undefined && cursorFormat !== format) return failed(format, "CURSOR_MISMATCH", "the cursor stopped inside an item in the other format; repeat the request in that format", { errors: [cursorIssue("CURSOR_MISMATCH", `format ${cursorFormat}`, `Use format "${cursorFormat}" to continue this item.`)] });
      return failed(format, "CURSOR_INVALID", "the cursor points outside the reply", { errors: [cursorIssue("CURSOR_INVALID", "a position inside the reply", "Start again without a cursor.")] });
    }
    start = { index, offset };
  }
  let page: ReturnType<typeof paginate>;
  try {
    page = paginate(layout, format, start, budget);
  } catch {
    // CLAIM(page-progress) was violated by an unforeseen shape; report it as a budget problem rather than crash or loop
    return failed(format, "BUDGET_TOO_SMALL", `maxBytes ${budget} cannot make progress through this reply`, { details: { minimumBytes: Math.min(32768, budget * 2) } });
  }
  const jsonBody = format === "json" ? page.body : layout.render(page.state, "json");
  return { ok: true, format, body: page.body, payload: JSON.parse(jsonBody), cursor: page.state.cursor };
}

// ---- listings (components, search, describe) --------------------------------------------------------------------------------

interface Listing {
  schema: string;
  jsonHead: Record<string, unknown>;
  textHead: string[];
  unit: string;
  total: number;
  matched: number;
  notice: string | null;
  entries: Entry[];
}

function listingLayout(listing: Listing, cursorAt: Layout["cursorAt"]): Layout {
  const render = (page: PageState, format: Format): string => {
    const counts = { unit: listing.unit, total: listing.total, matched: listing.matched, returned: page.returned, omitted: page.omitted, truncated: page.omitted > 0 || page.pending };
    if (format === "json") {
      return JSON.stringify({
        schemaVersion: listing.schema,
        ...listing.jsonHead,
        counts,
        ...(listing.notice === null ? {} : { notice: listing.notice }),
        items: page.slots.map((slot) => (slot.type === "whole" ? slot.entry.json : { fragment: { item_id: slot.entry.id, offset: slot.offset, length: slot.length, total: slot.total, text: slot.payload } })),
        cursor: page.cursor,
      });
    }
    const lines = [
      listing.schema,
      ...listing.textHead,
      `counts: unit=${counts.unit} total=${counts.total} matched=${counts.matched} returned=${counts.returned} omitted=${counts.omitted} truncated=${counts.truncated}`,
      `${page.returned}/${listing.matched} matched ${listing.unit} returned; ${page.omitted} omitted`,
    ];
    if (listing.notice !== null) lines.push(listing.notice);
    for (const slot of page.slots) lines.push(slot.type === "whole" ? slot.entry.text : `[fragment item=${slot.entry.id} offset=${slot.offset} length=${slot.length} total=${slot.total}] ${slot.payload}`);
    if (page.cursor !== null) lines.push(`cursor: ${page.cursor}`);
    return lines.join("\n") + "\n";
  };
  return { entries: listing.entries, render, cursorAt };
}

const cursorAtFor = (query: string): Layout["cursorAt"] => (index, offset, format) => encodeCursor(query, { index, offset, ...(offset > 0 ? { format } : {}) });

// ---- argument handling -----------------------------------------------------------------------------------------------------

const SESSION_FREE = new Set<string>(["list_components", "describe_component", "validate"]);

function contextOf(args: Record<string, unknown>): Context {
  const maxBytes = args.maxBytes;
  return {
    format: args.format === "json" ? "json" : "text",
    budget: typeof maxBytes === "number" && Number.isInteger(maxBytes) ? maxBytes : 8192,
    cursor: typeof args.cursor === "string" ? args.cursor : undefined,
  };
}

// ---- operations ----------------------------------------------------------------------------------------------------------------

function listComponents(args: { capability?: string }, context: Context): OperationOutcome {
  const known = COMPONENT_CATALOGUE.some((entry) => entry.capabilities.includes(args.capability ?? ""));
  const selected = COMPONENT_CATALOGUE.filter((entry) => args.capability === undefined || entry.capabilities.includes(args.capability));
  const entries: Entry[] = selected.map((entry) => ({
    id: entry.id, kind: "item", countable: true,
    json: { id: entry.id, question: entry.question, capabilities: entry.capabilities },
    text: `${entry.id} ${entry.question} [${entry.capabilities.join(", ")}]`,
  }));
  const query = queryDigest({ tool: "list_components", capability: args.capability ?? null });
  const layout = listingLayout({
    schema: "paneweft.components/1",
    jsonHead: { filters: args.capability === undefined ? {} : { capability: args.capability } },
    textHead: [`filters: ${args.capability === undefined ? "none" : `capability=${args.capability}`}`],
    unit: "components",
    total: selected.length,
    matched: selected.length,
    notice: args.capability !== undefined && !known ? `no component has the capability "${args.capability}"` : null,
    entries,
  }, cursorAtFor(query));
  return serve(layout, query, context);
}

const SCHEMA_FILES = new Map(loadSchemaDocuments().map((entry) => [entry.id, entry.document]));

function describeComponent(args: { component: ComponentId }, context: Context): OperationOutcome {
  const entry = COMPONENT_CATALOGUE.find((candidate) => candidate.id === args.component) as (typeof COMPONENT_CATALOGUE)[number];
  const document = JSON.stringify({
    id: entry.id,
    question: entry.question,
    capabilities: entry.capabilities,
    limits: {
      viewBytes: LIMITS.viewBytes, bundleBytes: LIMITS.bundleBytes, factItemsPerView: LIMITS.factItemsPerView, nestingLevels: LIMITS.nestingLevels,
      stringBytes: LIMITS.stringBytes, embedDepth: LIMITS.embedDepth, ...(entry.id === "graph" ? { graphNodes: LIMITS.graphNodes, graphEdges: LIMITS.graphEdges } : {}),
    },
    schema: SCHEMA_FILES.get(`urn:paneweft:schema:component:${entry.id}:1`),
    example: COMPONENT_EXAMPLES[entry.id],
  });
  const { format, budget } = context;
  const query = queryDigest({ tool: "describe_component", component: entry.id, maxBytes: budget });
  // chunks: greedy, as large as the budget allows with the real page framing (chunkCount is sized for three digits)
  const bytes = Buffer.from(document, "utf8");
  const pageOf = (chunk: string, index: number, count: number, cursor: string | null): string =>
    format === "json"
      ? JSON.stringify({ component: entry.id, section: "document", chunk, chunkIndex: index, chunkCount: count, cursor })
      : `paneweft.describe/1 component=${entry.id} chunk=${index + 1}/${count}\n${chunk}\n${cursor === null ? "" : `cursor: ${cursor}\n`}`;
  const sampleCursor = encodeCursor(query, { index: 999, offset: 0 });
  const chunks: string[] = [];
  for (let from = 0; from < bytes.length;) {
    let low = from;
    let high = bytes.length;
    const align = (end: number): number => { let at = end; while (at > from && at < bytes.length && ((bytes[at] as number) & 0xc0) === 0x80) at--; return at; };
    while (low < high) {
      let probe = align(Math.ceil((low + high) / 2));
      if (probe <= low) probe = high;
      const fits = Buffer.byteLength(pageOf(bytes.subarray(from, probe).toString("utf8"), 999, 999, sampleCursor), "utf8") <= budget;
      if (fits) low = probe;
      else high = align(probe - 1);
    }
    if (low <= from) return failed(format, "BUDGET_TOO_SMALL", `maxBytes ${budget} cannot carry any part of the description`, { details: { minimumBytes: 2048 } });
    chunks.push(bytes.subarray(from, low).toString("utf8"));
    from = low;
  }
  let index = 0;
  if (context.cursor !== undefined) {
    const decoded = decodeCursor(context.cursor);
    if (!decoded.ok) return failed(format, "CURSOR_INVALID", "the cursor is not a cursor this server issued", { errors: [cursorIssue("CURSOR_INVALID", "an unmodified cursor", "Pass the cursor of the previous reply unchanged, or omit it.")] });
    if (decoded.query !== query) return failed(format, "CURSOR_MISMATCH", "the cursor belongs to a different query (component or budget)", { errors: [cursorIssue("CURSOR_MISMATCH", "the query that issued the cursor", "Repeat the original request with the cursor.")] });
    if (decoded.position.index >= chunks.length) return failed(format, "CURSOR_INVALID", "the cursor points outside the description", { errors: [cursorIssue("CURSOR_INVALID", "a position inside the description", "Start again without a cursor.")] });
    index = decoded.position.index;
  }
  const next = index + 1 < chunks.length ? encodeCursor(query, { index: index + 1, offset: 0 }) : null;
  const body = pageOf(chunks[index] as string, index, chunks.length, next);
  const payload = { component: entry.id, section: "document", chunk: chunks[index], chunkIndex: index, chunkCount: chunks.length, cursor: next };
  return { ok: true, format, body, payload, cursor: next };
}

const IDENTITY_NONE = "none (the document alone was checked, not compared with any session; pass --session DIR to also check registered definitions, entities and stored views)";
const IDENTITY_SESSION = "session (compared with this session's registered definitions, entities and stored views, as render would)";

/**
 * Without a session: the document alone. With one: exactly what render would decide (Session.preflight), nothing stored. The reply says which (#4):
 * `identity` is `session` or `none`.
 */
async function validateOperation(session: Session | null, args: { input: unknown }, context: Context): Promise<OperationOutcome> {
  let kind: string;
  let notes: ValidationNote[];
  if (session === null) {
    const report = validateSubmission(args.input);
    if (!report.ok) return failed(context.format, "VALIDATION_FAILED", `the input failed validation with ${report.errors.length} issue${report.errors.length === 1 ? "" : "s"}; first: ${report.errors[0]?.code} at "${report.errors[0]?.pointer}"`, { errors: report.errors });
    ({ kind, notes } = report);
  } else {
    const checked = await session.preflight(args.input);
    if (!checked.ok) return failedFrom(context.format, checked.error);
    ({ kind, notes } = checked.value);
  }
  const identity = session === null ? "none" : "session";
  const payload = { schemaVersion: "paneweft.validate/1", valid: true, kind, identity, notes };
  const body = context.format === "json" ? JSON.stringify(payload) : `valid: ${kind}\nidentity: ${session === null ? IDENTITY_NONE : IDENTITY_SESSION}\n${notes.map((note) => `note: ${note.pointer}: ${note.message}\n`).join("")}`;
  return { ok: true, format: context.format, body, payload, cursor: null };
}

async function registerView(session: Session, args: { definition: unknown; expectedRevision: number }, context: Context): Promise<OperationOutcome> {
  const result = await session.registerView(args.definition, args.expectedRevision);
  if (!result.ok) return failedFrom(context.format, result.error, "/definition");
  const id = (args.definition as { id?: string }).id ?? "";
  const payload = { schemaVersion: "paneweft.register_view/1", registered: id, revision: result.value.revision };
  const body = context.format === "json" ? JSON.stringify(payload) : `registered definition ${id}\nregistry revision: ${result.value.revision}\n`;
  return { ok: true, format: context.format, body, payload, cursor: null };
}

// -- views ---------------------------------------------------------------------------------------------------------------------

async function embedsOf(session: SessionReader, envelope: Envelope): Promise<Map<string, EmbedInfo>> {
  const embeds = new Map<string, EmbedInfo>();
  for (const block of viewItems(envelope)) {
    if (block.kind !== "view" || typeof block.viewId !== "string" || block.viewId === envelope.id) continue; // an embed of itself is cut
    const found = await session.getView({ viewId: block.viewId, snapshotId: referencedSnapshot(envelope, block.viewId) });
    if (!found.ok) continue;
    const inner = found.value.envelope;
    if (inner.component === "notebook") embeds.set(block.id, { kind: "notebook", viewId: inner.id, blocks: viewItems(inner) });
    else embeds.set(block.id, { kind: "view", viewId: inner.id, component: inner.component, headerLine: `paneweft.reply/1 view=${inner.id} component=${inner.component}` });
  }
  return embeds;
}

interface Loaded { envelope: Envelope; summary: ViewSummary }

async function loadView(session: SessionReader, key: ViewKey, query: ViewQuery, format: ReplyFormat): Promise<Loaded | OperationOutcome> {
  const snapshot = await session.snapshotInfo(key.snapshotId);
  if (!snapshot.ok) return snapshot.error.code === "NOT_FOUND" ? unresolved(format, `snapshot "${key.snapshotId}" does not exist`) : failedFrom(format, snapshot.error);
  const stored = await readEffectiveView(session, key);
  if (!stored.ok) return stored.error.code === "NOT_FOUND" ? unresolved(format, `view "${key.viewId}" does not exist in snapshot "${key.snapshotId}"`) : failedFrom(format, stored.error);
  const envelope = stored.value.envelope;
  const freshness = await checkFreshness(envelope.freshness, await session.repositories());
  const embeds = query.embedDepth === 1 && envelope.component === "notebook" ? await embedsOf(session, envelope) : new Map<string, EmbedInfo>();
  try {
    return { envelope, summary: summariseView(envelope, freshness, query, embeds, stored.value.recorded) };
  } catch (error) {
    if (error instanceof QueryError) {
      return failed(format, "INVALID_ARGUMENT", error.message, { errors: [{ code: error.code, pointer: error.pointer, constraint: "a query the view can answer", hint: error.message }] });
    }
    throw error;
  }
}
const isOutcome = (value: Loaded | OperationOutcome): value is OperationOutcome => "ok" in value;

const DEFAULT_QUERY: ViewQuery = { filter: {}, embedDepth: 0 };

function inspectDigest(key: ViewKey, query: ViewQuery, order: ViewOrder | null): string {
  return queryDigest({ tool: "inspect_view", viewId: key.viewId, snapshotId: key.snapshotId, filter: query.filter, order, embedDepth: query.embedDepth, focus: query.focus ?? null });
}

async function inspectView(session: SessionReader, args: { viewId: string; snapshotId: string; filter?: ViewFilter; order?: ViewOrder; focus?: { itemId: string; expand?: boolean }; embedDepth?: number }, context: Context): Promise<OperationOutcome> {
  const key = { viewId: args.viewId, snapshotId: args.snapshotId };
  const query: ViewQuery = { filter: args.filter ?? {}, embedDepth: args.embedDepth ?? 0, ...(args.order === undefined ? {} : { order: args.order }), ...(args.focus === undefined ? {} : { focus: args.focus }) };
  const loaded = await loadView(session, key, query, context.format);
  if (isOutcome(loaded)) return loaded;
  const digest = inspectDigest(key, query, loaded.summary.order);
  return serve(layoutOf(loaded.summary, cursorAtFor(digest)), digest, context);
}

// -- panes ---------------------------------------------------------------------------------------------------------------------

interface PaneView { viewId: string; definitionId: string; completeness: ViewCompleteness }

/** The stored views of `entity` in `snapshotId`, from the view index: no stored object is opened (T5). */
async function viewsOfEntity(session: SessionReader, entity: EntityRef, snapshotId: string): Promise<PaneView[]> {
  return (await session.listViewIndex(snapshotId))
    .filter((view) => view.entity.repository === entity.repository && view.entity.kind === entity.kind && view.entity.id === entity.id)
    .map((view) => ({ viewId: view.viewId, definitionId: view.viewDefinitionId, completeness: view.completeness }));
}

/** The built-in `*` views, answered from the entity record itself. */
function builtinSummary(entity: Entity, which: "builtin:metadata" | "builtin:raw", notice: string | null): ViewSummary {
  const facts: Array<[string, string]> = which === "builtin:metadata"
    ? [
      ["repository", entity.repository], ["kind", entity.kind], ["id", entity.id], ["snapshotId", entity.snapshotId], ["label", entity.label],
      ["dataRoles", entity.dataRoles.join(", ")], ["relations", entity.relations.map((relation) => `${relation.name} -> ${relation.target.kind}:${relation.target.id}`).join("; ")],
    ]
    : Object.entries(entity).map(([key, value]): [string, string] => [key, JSON.stringify(value)]);
  const entries: Entry[] = facts.map(([name, value]) => ({ id: name, kind: "item", countable: true, json: { id: name, label: name, value }, text: `${name}: ${value}` }));
  return {
    view: { id: which, title: which === "builtin:metadata" ? "Metadata" : "Raw", component: "shape", snapshotId: entity.snapshotId },
    question: which === "builtin:metadata" ? "What does the inspector know about this entity?" : "What is the raw record of this entity?",
    completeness: { status: "complete", criterion: "every field of the registered entity record" },
    freshness: { status: "fresh" },
    provenance: { read: 0, parsed: 0, compiled: 0, observed: 0, inferred: 0 },
    evidenceSources: [],
    filters: {},
    order: null,
    unit: "fields",
    total: entries.length,
    matched: entries.length,
    notice,
    bodyPrelude: [],
    jsonExtras: {},
    footer: () => [],
    entries,
    gaps: [],
  };
}

interface Opened { summary: ViewSummary; pane: Record<string, unknown>; extras: ReplyExtras; digest: string }

async function openEntity(session: SessionReader, entityRef: EntityRef, snapshotId: string, preferred: string | undefined, format: ReplyFormat): Promise<Opened | OperationOutcome> {
  const snapshot = await session.snapshotInfo(snapshotId);
  if (!snapshot.ok) return snapshot.error.code === "NOT_FOUND" ? unresolved(format, `snapshot "${snapshotId}" does not exist`) : failedFrom(format, snapshot.error);
  const entity = await session.getEntity(entityRef, snapshotId);
  if (!entity.ok) return entity.error.code === "NOT_FOUND" ? unresolved(format, `entity ${entityRef.kind}/${entityRef.id} (repository ${entityRef.repository}) does not exist in snapshot "${snapshotId}"`) : failedFrom(format, entity.error);
  const instances = await viewsOfEntity(session, entityRef, snapshotId);
  const { definitions } = await session.listDefinitions();
  const ranked: RankOutput = rankViews({
    entity: entity.value, definitions, instances: instances.map((instance) => ({ definitionId: instance.definitionId, completeness: instance.completeness })),
    ...(preferred === undefined ? {} : { preferredViewDefinitionId: preferred }),
  });
  if (ranked.selected === null) return unresolved(format, `entity ${entityRef.id} has no available view in snapshot "${snapshotId}"`);
  const selected = ranked.selected;
  const describe = (status: "available" | "needs_data" | "unsupported") => ranked.views.filter((view) => view.availability.status === status).map((view) => ({
    viewDefinitionId: view.definitionId, title: view.title, component: view.component, priority: view.priority,
    ...(view.availability.status === "needs_data" ? { missing: view.availability.missingRoles } : {}),
    ...(view.availability.status === "unsupported" ? { reason: view.availability.reason } : {}),
  }));
  const views = { available: describe("available"), needs_data: describe("needs_data"), unsupported: describe("unsupported") };
  const pane = { entity: entityRef, snapshotId, viewDefinitionId: selected.definitionId, selection: [], filters: {}, pinned: false };
  const footer = [
    ...views.available.map((view) => `available: ${view.viewDefinitionId} ${view.title} (${view.component})`),
    ...views.needs_data.map((view) => `needs_data: ${view.viewDefinitionId} ${view.title} missing: ${(view as { missing: string[] }).missing.join(", ")}`),
    ...views.unsupported.map((view) => `unsupported: ${view.viewDefinitionId} ${view.title} (${(view as { reason: string }).reason})`),
  ];
  const instance = instances.find((candidate) => candidate.definitionId === selected.definitionId);
  let summary: ViewSummary;
  if (instance !== undefined) {
    const loaded = await loadView(session, { viewId: instance.viewId, snapshotId }, DEFAULT_QUERY, format);
    if (isOutcome(loaded)) return loaded;
    summary = loaded.summary;
  } else {
    const builtin = selected.definitionId === "builtin:raw" ? "builtin:raw" : "builtin:metadata";
    summary = builtinSummary(entity.value, builtin, selected.definitionId.startsWith("builtin:") ? null : `no view of definition "${selected.definitionId}" is stored for this entity in snapshot "${snapshotId}"`);
  }
  const digest = queryDigest({ tool: "open_entity", entity: entityRef, snapshotId, selected: selected.definitionId });
  return {
    summary, pane, digest,
    extras: { json: { pane, views, selected: { viewDefinitionId: selected.definitionId, ...(selected.fallbackFrom === undefined ? {} : { fallbackFrom: selected.fallbackFrom }) } }, footer },
  };
}
const isOpened = (value: Opened | OperationOutcome): value is Opened => "pane" in value;

async function openEntityOperation(session: SessionReader, args: { entity: EntityRef; snapshotId: string; preferredViewDefinitionId?: string }, context: Context): Promise<OperationOutcome> {
  const opened = await openEntity(session, args.entity, args.snapshotId, args.preferredViewDefinitionId, context.format);
  if (!isOpened(opened)) return opened;
  return serve(layoutOf(opened.summary, cursorAtFor(opened.digest), opened.extras), opened.digest, context);
}

const PANE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["entity", "snapshotId", "viewDefinitionId"],
  properties: {
    entity: { type: "object", additionalProperties: false, required: ["repository", "id", "kind"], properties: { repository: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 }, kind: { type: "string", minLength: 1 } } },
    snapshotId: { type: "string", minLength: 1 }, viewDefinitionId: { type: "string", minLength: 1 },
    selection: { type: "array", items: { type: "string" } }, filters: { type: "object" }, pinned: { type: "boolean" },
  },
};

async function navigate(session: SessionReader, args: { pane: Record<string, unknown>; itemId: string; action?: "open-entity" | "open-source" }, context: Context): Promise<OperationOutcome> {
  const { format } = context;
  const paneIssues = validateAgainstOwnerSchema(PANE_SCHEMA, args.pane, "/pane");
  if (paneIssues.length > 0) return failed(format, "INVALID_ARGUMENT", `the pane is not a pane state: ${paneIssues[0]?.code} at "${paneIssues[0]?.pointer}"`, { errors: paneIssues });
  const pane = args.pane as { entity: EntityRef; snapshotId: string; viewDefinitionId: string };
  const snapshot = await session.snapshotInfo(pane.snapshotId);
  if (!snapshot.ok) return unresolved(format, `snapshot "${pane.snapshotId}" does not exist`);
  const entity = await session.getEntity(pane.entity, pane.snapshotId);
  if (!entity.ok) return unresolved(format, `entity ${pane.entity.kind}/${pane.entity.id} does not exist in snapshot "${pane.snapshotId}"`);
  const builtin = pane.viewDefinitionId.startsWith("builtin:");
  let item: AnyItem | undefined;
  let viewKey: ViewKey | undefined;
  if (builtin) {
    const synthetic = builtinSummary(entity.value, pane.viewDefinitionId === "builtin:raw" ? "builtin:raw" : "builtin:metadata", null);
    if (!synthetic.entries.some((candidate) => candidate.id === args.itemId)) return unresolved(format, `item "${args.itemId}" does not exist in view "${pane.viewDefinitionId}" of entity ${pane.entity.id}`);
  } else {
    const instance = (await viewsOfEntity(session, pane.entity, pane.snapshotId)).find((candidate) => candidate.definitionId === pane.viewDefinitionId);
    if (instance === undefined) return unresolved(format, `no stored view of definition "${pane.viewDefinitionId}" for entity ${pane.entity.id} in snapshot "${pane.snapshotId}"`);
    // the items are those inspect lists: the effective view, which for an example includes its recorded runs (review round 2, S12)
    const effective = await readEffectiveView(session, { viewId: instance.viewId, snapshotId: pane.snapshotId });
    if (!effective.ok) return effective.error.code === "NOT_FOUND" ? unresolved(format, `view "${instance.viewId}" does not exist in snapshot "${pane.snapshotId}"`) : failedFrom(format, effective.error);
    item = viewItems(effective.value.envelope).find((candidate) => candidate.id === args.itemId);
    if (item === undefined) return unresolved(format, `item "${args.itemId}" does not exist in view "${instance.viewId}" of snapshot "${pane.snapshotId}"`);
    viewKey = { viewId: instance.viewId, snapshotId: pane.snapshotId };
  }
  if ((args.action ?? "open-entity") === "open-source") {
    if (viewKey === undefined) return unresolved(format, `item "${args.itemId}" of a built-in view has no source anchor`);
    const opening = await resolveItemSource(session, viewKey, args.itemId);
    if (opening.status === "unresolved") return unresolved(format, opening.message);
    const entries: Entry[] = opening.stored.lines.map((line) => ({ id: `L${line.n}`, kind: "item", countable: true, json: { id: `L${line.n}`, line: line.n, text: line.text, highlighted: line.n >= opening.highlight[0] && line.n <= opening.highlight[1] }, text: `${line.n}: ${line.text}` }));
    const query = queryDigest({ tool: "navigate", viewKey, itemId: args.itemId, action: "open-source" });
    const listing = listingLayout({
      schema: "paneweft.source/1",
      jsonHead: { repository: opening.repository, revision: opening.revision, path: opening.path, highlight: opening.highlight, origin: opening.origin, storedView: opening.stored.viewId, currency: opening.currency },
      textHead: [`source: ${opening.repository} ${opening.revision ?? "no revision"} ${opening.path}`, `highlight: ${opening.highlight[0]}-${opening.highlight[1]}`, `origin: ${opening.origin}`, `currency: ${opening.currency.state}`],
      unit: "lines", total: entries.length, matched: entries.length, notice: null, entries,
    }, cursorAtFor(query));
    return serve(listing, query, context);
  }
  const target = item === undefined ? undefined : (item.entity ?? (item.result as EntityRef | undefined));
  if (target === undefined) {
    const notice = { code: "NO_TARGET", itemId: args.itemId, message: `item ${args.itemId} has no entity to open` };
    const payload = { schemaVersion: "paneweft.navigate/1", pane: null, notice, cursor: null };
    return { ok: true, format, body: format === "json" ? JSON.stringify(payload) : `paneweft.navigate/1\nNO_TARGET: ${notice.message}\n`, payload, cursor: null };
  }
  const opened = await openEntity(session, target, pane.snapshotId, undefined, format);
  if (!isOpened(opened)) return opened;
  return serve(layoutOf(opened.summary, cursorAtFor(opened.digest), opened.extras), opened.digest, context);
}

// -- render, notebooks, examples ----------------------------------------------------------------------------------------------

async function viewerUrl(session: Session, key: ViewKey | undefined): Promise<string | null> {
  try {
    const info = JSON.parse(await readFile(join(session.dir, "server.json"), "utf8")) as { origin?: string; token?: string; pid?: number };
    if (typeof info.origin !== "string" || typeof info.token !== "string" || typeof info.pid !== "number") return null;
    try { process.kill(info.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return null; }
    return `${info.origin}/#token=${info.token}${key === undefined ? "" : `&view=${encodeURIComponent(key.viewId)}&snapshot=${encodeURIComponent(key.snapshotId)}`}`;
  } catch {
    return null;
  }
}

const NOTES_BYTE_BUDGET = 512;
const clipText = (text: string, points: number): string => { const all = Array.from(text); return all.length <= points ? text : `${all.slice(0, points - 1).join("")}…`; };
/** The notes that fit NOTES_BYTE_BUDGET bytes of JSON (each clipped to a 120-point pointer and a 160-point message), in order, and how many were left out. */
function boundedNotes(all: ValidationNote[]): { listed: ValidationNote[]; omitted: number } {
  const listed: ValidationNote[] = [];
  let used = 0;
  for (const note of all) {
    const bounded = { pointer: clipText(note.pointer, 120), message: clipText(note.message, 160) };
    const size = byteLength(JSON.stringify(bounded));
    if (used + size > NOTES_BYTE_BUDGET) break;
    listed.push(bounded);
    used += size;
  }
  return { listed, omitted: all.length - listed.length };
}

async function render(session: Session, args: { input: Record<string, unknown> }, context: Context): Promise<OperationOutcome> {
  const { format } = context;
  const isBundle = args.input.schemaVersion === "paneweft.bundle/1";
  const stored = isBundle ? await session.importBundle(args.input) : await session.putView(args.input);
  if (!stored.ok) return failedFrom(format, stored.error);
  const summaryOfStore = stored.value;
  const first = summaryOfStore.views[0];
  const url = await viewerUrl(session, first);
  const storedList = summaryOfStore.views.slice(0, 20).map((key) => `${key.viewId}@${key.snapshotId}`);
  const more = summaryOfStore.views.length - storedList.length;
  // the validator's notes on the accepted document; the ones that fit NOTES_BYTE_BUDGET (512 bytes of JSON) are listed, the rest are counted, so the mandatory part of the reply stays small
  const { listed: notes, omitted: notesOmitted } = boundedNotes(summaryOfStore.notes);
  const noteLines = [...notes.map((note) => `note: ${note.pointer}: ${note.message}`), ...(notesOmitted > 0 ? [`(+${notesOmitted} more notes)`] : [])];
  const jsonHead = { stored: summaryOfStore.views, viewerUrl: url, validation: { valid: true, notes, ...(notesOmitted > 0 ? { omitted: notesOmitted } : {}) } };
  if (first === undefined) {
    const payload = { schemaVersion: "paneweft.render/1", ...jsonHead, entities: summaryOfStore.entities, definitions: summaryOfStore.definitions, cursor: null };
    return { ok: true, format, body: format === "json" ? JSON.stringify(payload) : `paneweft.render/1\nstored: nothing (${summaryOfStore.entities} entities, ${summaryOfStore.definitions} definitions)\nviewer: ${url ?? "none"}\n${noteLines.map((line) => `${line}\n`).join("")}`, payload, cursor: null };
  }
  const read = await snapshotOf(session, format);
  if ("ok" in read) return read;
  const loaded = await loadView(read, first, DEFAULT_QUERY, format);
  if (isOutcome(loaded)) return loaded;
  const digest = inspectDigest(first, DEFAULT_QUERY, loaded.summary.order);
  const preamble = [`stored: ${storedList.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`, `viewer: ${url ?? "none"}`, ...noteLines];
  return serve(layoutOf(loaded.summary, cursorAtFor(digest), { preamble, json: jsonHead }), digest, context);
}

async function notebookReply(session: SessionReader, pageId: string, revision: number | undefined, snapshotId: string | undefined, context: Context): Promise<OperationOutcome> {
  const page = await session.notebookGet(pageId, revision, snapshotId);
  if (!page.ok) return page.error.code === "NOT_FOUND" ? unresolved(context.format, page.error.message) : failedFrom(context.format, page.error);
  const freshness = await checkFreshness(page.value.envelope.freshness, await session.repositories());
  const summary = summariseView(page.value.envelope, freshness, DEFAULT_QUERY);
  const digest = queryDigest({ tool: "notebook_get", pageId, snapshotId: page.value.snapshotId, revision: page.value.revision });
  return serve(layoutOf(summary, cursorAtFor(digest), { preamble: [`page: ${pageId} revision ${page.value.revision}`], json: { pageId, revision: page.value.revision } }), digest, context);
}

async function notebookCreate(session: Session, args: { input: unknown }, context: Context): Promise<OperationOutcome> {
  const created = await session.notebookCreate(args.input);
  if (!created.ok) return failedFrom(context.format, created.error);
  return withSnapshot(session, context, (read) => notebookReply(read, created.value.pageId, created.value.revision, created.value.snapshotId, context));
}

async function notebookUpdate(session: Session, args: { pageId: string; snapshotId?: string; expectedRevision: number; blocks: unknown[]; sources?: unknown[] }, context: Context): Promise<OperationOutcome> {
  const updated = await session.notebookUpdate(args.pageId, args.expectedRevision, { blocks: args.blocks, ...(args.sources === undefined ? {} : { sources: args.sources }) }, args.snapshotId);
  if (!updated.ok) return failedFrom(context.format, updated.error);
  return withSnapshot(session, context, (read) => notebookReply(read, updated.value.pageId, updated.value.revision, updated.value.snapshotId, context));
}

async function exampleRecord(session: Session, args: { viewId: string; snapshotId: string; output: unknown }, context: Context): Promise<OperationOutcome> {
  const recorded = await session.recordExampleRun({ viewId: args.viewId, snapshotId: args.snapshotId }, args.output);
  if (!recorded.ok) return failedFrom(context.format, recorded.error, "/output");
  const run = recorded.value;
  const payload = { schemaVersion: "paneweft.example_record/1", recorded: run };
  const body = context.format === "json" ? JSON.stringify(payload) : `recorded run ${run.runId}: ${run.status}\nview: ${run.viewId}@${run.snapshotId}\ncontent: ${run.contentHash}\n`;
  return { ok: true, format: context.format, body, payload, cursor: null };
}

// -- search ----------------------------------------------------------------------------------------------------------------------

async function search(session: SessionReader, args: { query: string; scope?: { entity: EntityRef; snapshotId: string } }, context: Context): Promise<OperationOutcome> {
  const ranked = await searchSession(session, args.query, args.scope);
  const entries: Entry[] = ranked.map((document) => ({
    id: `${document.type}:${document.id}@${document.snapshotId}`, kind: "item", countable: true,
    json: { type: document.type, id: document.id, text: document.text, snapshotId: document.snapshotId, ...document.extra },
    text: `${document.type} ${document.id} ${JSON.stringify(document.text)} (${document.snapshotId})`,
  }));
  const query = queryDigest({ tool: "search", query: args.query, scope: args.scope ?? null });
  const layout = listingLayout({
    schema: "paneweft.search/1",
    jsonHead: { query: args.query, ...(args.scope === undefined ? {} : { scope: args.scope }) },
    textHead: [`query: ${JSON.stringify(args.query)}`],
    unit: "results", total: entries.length, matched: entries.length,
    notice: entries.length === 0 ? `no entity, view, example or claim matches ${JSON.stringify(args.query)}` : null,
    entries,
  }, cursorAtFor(query));
  return serve(layout, query, context);
}

const withSnapshot = async (session: Session, context: Context, run: (read: SessionReader) => Promise<OperationOutcome>): Promise<OperationOutcome> => {
  const read = await snapshotOf(session, context.format);
  return "ok" in read ? read : run(read);
};

/** One manifest read for a compound operation (T5); a manifest that cannot be read is the operation's storage error, as the first read used to report it. */
async function snapshotOf(session: Session, format: ReplyFormat): Promise<SessionReader | OperationOutcome> {
  try {
    return await session.snapshot();
  } catch (error) {
    if (error instanceof SessionStorageError) return failed(format, error.code, error.message);
    throw error;
  }
}

// ---- entry point -----------------------------------------------------------------------------------------------------------------

/** The one exit: an outcome within the budget is returned as is; otherwise it is replaced by its bounded form (reply-budget.ts). */
export function enforceReplyBudget(outcome: OperationOutcome, budget: number, operation: string): OperationOutcome {
  if (byteLength(outcome.body) <= budget) return outcome;
  if (!outcome.ok) {
    const error = boundError(outcome.error, budget);
    return { ok: false, format: outcome.format, body: JSON.stringify(error), error };
  }
  const bounded = boundSuccessBody(outcome.body, outcome.format, operation, budget);
  return { ok: true, format: outcome.format, body: bounded.body, payload: bounded.payload, cursor: null };
}

export async function executeOperation(session: Session | null, name: string, args: unknown): Promise<OperationOutcome> {
  const maxBytes = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as { maxBytes?: unknown }).maxBytes : undefined;
  return enforceReplyBudget(await dispatchOperation(session, name, args), replyBudget(maxBytes), name);
}

async function dispatchOperation(session: Session | null, name: string, args: unknown): Promise<OperationOutcome> {
  const requestedFormat: ReplyFormat = args !== null && typeof args === "object" && !Array.isArray(args) && (args as { format?: unknown }).format === "json" ? "json" : "text";
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return failed(requestedFormat, "UNKNOWN_OPERATION", `unknown operation "${name}"; the operations are ${TOOL_NAMES.join(", ")}`);
  if (session === null && !SESSION_FREE.has(name)) return failed(requestedFormat, "SESSION_REQUIRED", `${name} needs a session; pass --session DIR (or set PANEWEFT_SESSION) / start paneweft mcp with --session DIR`);
  try {
    const issues = validateToolArguments(name, args);
    const budgetTooSmall = issues.some((issue) => issue.pointer === "/maxBytes" && issue.code === "OUT_OF_RANGE") && typeof (args as { maxBytes?: unknown }).maxBytes === "number" && Number.isInteger((args as { maxBytes: number }).maxBytes) && (args as { maxBytes: number }).maxBytes < BUDGET_FLOOR;
    const remaining = budgetTooSmall ? issues.filter((issue) => !(issue.pointer === "/maxBytes" && issue.code === "OUT_OF_RANGE")) : issues;
    if (remaining.length > 0) return failed(requestedFormat, "INVALID_ARGUMENT", `the arguments of ${name} are invalid: ${remaining[0]?.code} at "${remaining[0]?.pointer}"`, { errors: remaining });
    const input = args as Record<string, any>;
    const context = contextOf(input);
    const live = session as Session;
    switch (name) {
      case "list_components": return listComponents(input, context);
      case "describe_component": return describeComponent(input as { component: ComponentId }, context);
      case "validate": return await validateOperation(session, input as { input: unknown }, context);
      case "register_view": return await registerView(live, input as { definition: unknown; expectedRevision: number }, context);
      case "render": return await render(live, input as { input: Record<string, unknown> }, context);
      case "open_entity": return await withSnapshot(live, context, (read) => openEntityOperation(read, input as { entity: EntityRef; snapshotId: string }, context));
      case "navigate": return await withSnapshot(live, context, (read) => navigate(read, input as { pane: Record<string, unknown>; itemId: string }, context));
      case "inspect_view": return await withSnapshot(live, context, (read) => inspectView(read, input as { viewId: string; snapshotId: string }, context));
      case "search": return await withSnapshot(live, context, (read) => search(read, input as { query: string }, context));
      case "notebook_create": return await notebookCreate(live, input as { input: unknown }, context);
      case "notebook_get": return await withSnapshot(live, context, (read) => notebookReply(read, input.pageId as string, input.revision as number | undefined, input.snapshotId as string | undefined, context));
      case "notebook_update": return await notebookUpdate(live, input as { pageId: string; snapshotId?: string; expectedRevision: number; blocks: unknown[] }, context);
      case "example_record": return await exampleRecord(live, input as { viewId: string; snapshotId: string; output: unknown }, context);
      default: return failed(requestedFormat, "UNKNOWN_OPERATION", `unknown operation "${name}"`);
    }
  } catch (error) {
    return failed(requestedFormat, "INTERNAL", `${name} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const BUDGET_FLOOR = 2048;
