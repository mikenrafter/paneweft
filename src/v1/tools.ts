// The agent tools (spec section 6, MCP and CLI contract) as shared handlers. CLI and MCP are thin adapters over this.
//
// Discovery tools read the catalogue the owner compiled and NEVER execute code or assert absence: a type the catalogue does not carry
// is a partial reply that names the scope the catalogue covered. `collect` is the one code-executing tool, and it only runs an
// adapter the owner registered. Every reply fits its byte budget and continues through content-bound cursors.
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve as resolvePath } from "node:path";
import { canonicalJson, compareCodeUnits } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import { decodeCursor, encodeCursor, queryDigest } from "../core/cursor.ts";
import { err, type OperationError, type OperationErrorCode, type ValidationIssue } from "../core/errors.ts";
import type { OperationOutcome, ReplyFormat } from "../core/operations.ts";
import type { Session } from "../core/session.ts";
import type { Envelope } from "../core/wire.ts";
import { dereference } from "../schemas/dereference.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { Diagnostic } from "../generated/v1/ObjectGraph.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import type { AdapterRecord } from "./adapters.ts";
import { coverage as coverageOf, type Coverage } from "./catalogue.ts";
import { qualifyDiagnosticId, splitDiagnosticId } from "./diagnostic-id.ts";
import type { Inventory } from "../generated/v1/Inventory.ts";
import type { Fingerprint } from "./fingerprint.ts";
import type { JobService } from "./jobs.ts";
import { withStoredPages } from "./pages.ts";
import { adaptersOf, freshnessOf, judgeRun, type Consistency, type Freshness } from "./snapshot-freshness.ts";
import { captureFile, committedImport, openV1Reader, readJsonFile } from "./read.ts";
import { V1_READ_ONLY_TOOLS, V1_TOOL_NAMES, createV1SchemaRegistry, loadV1SchemaDocuments, validateAgainstV1, type V1ToolName } from "./schemas.ts";

export interface V1Context {
  session: Session | null;
  /** The session directory: adapters.json, catalogues/, jobs/ and renderers.trust.json live here. */
  sessionDir: string | null;
  jobs: JobService | null;
}

type Json = any;

/** The advertised descriptors (name, description, dereferenced input schema) of the ten v1 tools. Read-only tools carry the hint;
 * annotations are hints, never enforcement (spec section 6). */
export function v1ToolDescriptors(): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean } }> {
  const documents = new Map(loadV1SchemaDocuments().map((entry) => [entry.id, entry.document as Json]));
  const all = new Map([...documents, ...createV1Documents()]);
  return V1_TOOL_NAMES.map((name) => {
    const document = documents.get(`urn:paneweft:schema:tool:${name}:1`) as Json;
    const { title: _title, description, ...schema } = document;
    return { name, description: String(description), inputSchema: dereference({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }, all, document), annotations: { readOnlyHint: (V1_READ_ONLY_TOOLS as readonly string[]).includes(name) } };
  });
}

function createV1Documents(): Map<string, Json> {
  // the v0 documents the tool schemas reference (common ids)
  const registry = createV1SchemaRegistry();
  const documents = new Map<string, Json>();
  const common = registry.getSchema("urn:paneweft:schema:common:1");
  if (common?.schema !== undefined) documents.set("urn:paneweft:schema:common:1", common.schema as Json);
  return documents;
}

// ---- outcomes ---------------------------------------------------------------------------------------------------------------------

function failure(format: ReplyFormat, code: OperationErrorCode, message: string, extra: { errors?: ValidationIssue[]; details?: Record<string, unknown>; retryable?: boolean } = {}): OperationOutcome {
  const error: OperationError = { schemaVersion: "paneweft.error/1", code, message, errors: extra.errors ?? [], retryable: extra.retryable ?? false, ...(extra.details === undefined ? {} : { details: extra.details }) };
  return { ok: false, format, body: JSON.stringify(error), error };
}
const fromError = (format: ReplyFormat, error: OperationError): OperationOutcome => ({ ok: false, format, body: JSON.stringify(error), error });

// ---- replies ----------------------------------------------------------------------------------------------------------------------

interface Item { json: Json; text: string }
interface ReplySpec {
  tool: string;
  completeness: { status: "complete" | "partial" | "unsupported"; reason?: string };
  freshness: Freshness;
  unit: string;
  total: number;
  /** All matched items in order; the page is a prefix of what follows `start`. */
  items: Item[];
  notices?: string[];
  details?: Json;
  /** Text-format only: lines printed after the header for facts that the JSON form carries in `details` (a scaffold's patch, for one). */
  textLines?: string[];
  /** What defines the listing a cursor continues (tool and its filters, never the budget). */
  query: Json;
}

function freshnessLine(freshness: Freshness): string {
  switch (freshness.status) {
    case "fresh": return freshness.catalogueDigest === undefined ? "fresh" : `fresh (catalogue ${freshness.catalogueDigest})`;
    case "stale": return `stale (changed: ${(freshness.reasons ?? []).join(", ")})`;
    case "unverified": return `unverified (${(freshness.reasons ?? []).join("; ")})`;
    default: return "not-applicable";
  }
}

function renderReply(spec: ReplySpec, format: ReplyFormat, start: number, count: number, cursor: string | null): string {
  const page = spec.items.slice(start, start + count);
  const counts = { unit: spec.unit, total: spec.total, matched: spec.items.length, returned: page.length, omitted: spec.items.length - page.length - start + Math.max(0, start - 0) - Math.max(0, start), truncated: cursor !== null };
  counts.omitted = spec.items.length - start - page.length;
  if (format === "json") {
    return JSON.stringify({ schemaVersion: "paneweft.reply/2", tool: spec.tool, completeness: spec.completeness, freshness: spec.freshness, counts, items: page.map((item) => item.json), notices: spec.notices ?? [], cursor, ...(spec.details === undefined ? {} : { details: spec.details }) });
  }
  const lines = [`paneweft.reply/2 tool=${spec.tool}`, `completeness: ${spec.completeness.status}${spec.completeness.reason === undefined ? "" : ` (${spec.completeness.reason})`}`, `freshness: ${freshnessLine(spec.freshness)}`, `counts: unit=${counts.unit} total=${counts.total} matched=${counts.matched} returned=${counts.returned} omitted=${counts.omitted} truncated=${counts.truncated}`];
  for (const notice of spec.notices ?? []) lines.push(`notice: ${notice}`);
  if (spec.details?.text !== undefined) lines.push(...(spec.details.text as string[]));
  if (spec.textLines !== undefined) lines.push(...spec.textLines);
  for (const item of page) lines.push(item.text);
  if (cursor !== null) lines.push(`cursor: ${cursor}`);
  return lines.join("\n");
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** Serves one page of `spec` within `budget`: the longest prefix of items that fits, at least one; the cursor binds the query and the
 * content of the listing (CLAIM(cursor-content-bound)). */
function serveListing(spec: ReplySpec, args: { format: ReplyFormat; budget: number; cursor: string | undefined }): OperationOutcome {
  const { format, budget } = args;
  const query = queryDigest(spec.query);
  const content = queryDigest(spec.items.map((item) => item.json)).slice(0, 8);
  let start = 0;
  if (args.cursor !== undefined) {
    const decoded = decodeCursor(args.cursor);
    if (!decoded.ok) return failure(format, "CURSOR_INVALID", "the cursor is not a cursor this server issued", { errors: [{ code: "CONSTRAINT", pointer: "/cursor", constraint: "CURSOR_INVALID: an unmodified cursor", hint: "Pass the cursor of the previous reply unchanged, or start again without one." }] });
    if (decoded.query !== query) return failure(format, "CURSOR_MISMATCH", "the cursor belongs to a different query", { errors: [{ code: "CONSTRAINT", pointer: "/cursor", constraint: "CURSOR_MISMATCH: the query that issued it", hint: "Repeat the SAME request with the cursor, or drop the cursor for a new request." }] });
    if (decoded.content !== content) return failure(format, "CURSOR_STALE", "the listing changed since this cursor was issued; repeat the request without a cursor", { errors: [{ code: "CONSTRAINT", pointer: "/cursor", constraint: "CURSOR_STALE: the listing the cursor continues", hint: "Start again without a cursor." }] });
    start = decoded.position.index;
    if (start > spec.items.length) return failure(format, "CURSOR_INVALID", "the cursor points outside the listing");
  }
  const cursorAfter = (count: number): string | null => (start + count < spec.items.length ? encodeCursor(query, { index: start + count, offset: 0 }, content) : null);
  const fits = (count: number): boolean => bytes(renderReply(spec, format, start, count, cursorAfter(count))) <= budget;
  const remaining = spec.items.length - start;
  if (remaining === 0) {
    const body = renderReply(spec, format, start, 0, null);
    return bytes(body) <= budget ? { ok: true, format, body, payload: JSON.parse(renderReply(spec, "json", start, 0, null)), cursor: null } : failure(format, "BUDGET_TOO_SMALL", `maxBytes ${budget} is below the ${bytes(body)} bytes needed for the mandatory part of this reply`, { details: { minimumBytes: Math.min(32768, bytes(body)) } });
  }
  if (!fits(1)) {
    const needed = bytes(renderReply(spec, format, start, 1, cursorAfter(1)));
    return failure(format, "BUDGET_TOO_SMALL", `maxBytes ${budget} is below the ${needed} bytes needed for one item of this reply`, { details: { minimumBytes: Math.min(32768, needed) } });
  }
  let low = 1;
  let high = remaining;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const next = cursorAfter(low);
  return { ok: true, format, body: renderReply(spec, format, start, low, next), payload: JSON.parse(renderReply(spec, "json", start, low, next)), cursor: next };
}

// ---- reading the owner's configuration ---------------------------------------------------------------------------------------------

interface CatalogueRecord { schemaVersion: "paneweft.catalogue-record/1"; repo: string; adapter: string; catalogue: Catalogue; fingerprint: Fingerprint & { unverified?: string; sampledConsistency?: Consistency; sampleNote?: string }; inventory?: Inventory; collectedAt: string }

async function catalogueRecords(sessionDir: string, repo: string): Promise<CatalogueRecord[]> {
  const dir = join(sessionDir, "catalogues", repo);
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  const records: CatalogueRecord[] = [];
  for (const name of names) {
    const record = await readJsonFile<CatalogueRecord>(join(dir, name));
    if (record?.schemaVersion === "paneweft.catalogue-record/1") records.push(record);
  }
  return records;
}

// ---- tool implementations -----------------------------------------------------------------------------------------------------------

interface Call { context: { session: Session; sessionDir: string; jobs: JobService | null }; args: Record<string, any>; format: ReplyFormat; budget: number; cursor: string | undefined }

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "view";
const viewSortKey = (a: Catalogue["views"][number], b: Catalogue["views"][number]): number => a.priority - b.priority || compareCodeUnits(a.id, b.id);

/** CLAIM(T4-fresh-repo): a repository whose adapter is registered but whose catalogue is not stored yet (the first collect exports and stores it) is discovered
 * through one empty record per adapter, marked here: the answers are partial and unverified, never "nothing exists". */
const uncatalogued = new WeakSet<object>();
const NO_CATALOGUE_NOTICE = (repo: string): string => `no catalogue is stored for repository "${repo}" yet: the first collect of an example exports and stores it (this tool executes nothing). An empty answer is NOT a statement that no type, view or example exists; for a new view, scaffold_view takes an explicit source {path, symbol}`;

function emptyRecord(adapter: AdapterRecord): CatalogueRecord {
  const record: CatalogueRecord = { schemaVersion: "paneweft.catalogue-record/1", repo: adapter.repo, adapter: adapter.id, catalogue: { schemaVersion: "paneweft.catalogue/1", digest: "none", target: { runner: adapter.kind, package: adapter.id, features: adapter.features }, linkedScope: [], types: [], views: [], examples: [], duplicates: [] }, fingerprint: { digest: "", members: [], declaredExtras: [], exclusions: [] }, collectedAt: "" };
  uncatalogued.add(record);
  return record;
}

async function loadForRepo(call: Call, language?: string): Promise<{ records: CatalogueRecord[]; uncatalogued: boolean } | OperationOutcome> {
  const all = await catalogueRecords(call.context.sessionDir, call.args.repo as string);
  const wanted = language === "rust" ? "cargo" : language === "typescript" ? "vitest" : undefined;
  const records = wanted === undefined ? all : all.filter((record) => record.catalogue.target.runner === wanted);
  if (records.length > 0) return { records, uncatalogued: false };
  const adapters = (await adaptersOf(call.context.sessionDir)).filter((adapter) => adapter.repo === call.args.repo && (wanted === undefined || adapter.kind === wanted));
  if (adapters.length > 0) return { records: adapters.map(emptyRecord), uncatalogued: true };
  return failure(call.format, "NOT_FOUND", `no compiled catalogue is stored for repository "${call.args.repo}"${wanted === undefined ? "" : ` and language ${language}`}, and no adapter is registered for it to export one: the owner registers an adapter with \`paneweft adapter add --file <adapter.json>\` (the first collect through it exports and stores the catalogue; this tool executes nothing)`);
}

const isOutcome = (value: unknown): value is OperationOutcome => typeof value === "object" && value !== null && "ok" in value && "body" in value;

async function scopeFreshness(call: Call, record: CatalogueRecord): Promise<Freshness> {
  if (uncatalogued.has(record)) return { status: "unverified", reasons: ["no catalogue is stored yet: the first collect exports and stores it"] };
  const recorded = record.fingerprint.sampledConsistency ?? (record.fingerprint.unverified === undefined ? undefined : "unverified");
  return freshnessOf(call.context, record.repo, record.adapter, record.fingerprint, record.catalogue.digest, recorded);
}

const FRESHNESS_RANK: Record<Freshness["status"], number> = { fresh: 0, "not-applicable": 0, unverified: 1, stale: 2 };

/** The freshness of several scopes: the worst of them, with every reason, so no scope's doubt disappears into another's answer. */
async function mergedFreshness(call: Call, records: CatalogueRecord[]): Promise<Freshness> {
  const each = await Promise.all(records.map((record) => scopeFreshness(call, record)));
  if (each.length === 1) return each[0] as Freshness;
  const worst = each.reduce((a, b) => (FRESHNESS_RANK[b.status] > FRESHNESS_RANK[a.status] ? b : a));
  const reasons = each.flatMap((freshness, index) => (freshness.reasons ?? []).map((reason) => `${(records[index] as CatalogueRecord).adapter}: ${reason}`));
  return { status: worst.status, ...(reasons.length === 0 ? {} : { reasons }), catalogueDigest: queryDigest(records.map((record) => record.catalogue.digest)).slice(0, 12) };
}

/** What a reply says about the scopes it covers (S16). */
async function scopesOf(call: Call, records: CatalogueRecord[], runs: TestRun[]): Promise<Json[]> {
  return Promise.all(records.map(async (record) => ({ adapter: record.adapter, target: record.catalogue.target, linkedScope: record.catalogue.linkedScope, catalogueDigest: record.catalogue.digest, collectedAt: record.collectedAt, freshness: (await scopeFreshness(call, record)).status, coverage: coverageFigures(record, runs) })));
}

/** declared, linked, exercised and passing, from the checked-in inventory of the last refresh and the imported runs (S15). `declared` is null when no
 * inventory was checked: the figure is not guessed from the catalogue. */
function coverageFigures(record: CatalogueRecord, runs: TestRun[]): Omit<Coverage, "declared"> & { declared: number | null; inventory: "checked" | "none" } {
  if (record.inventory === undefined) return { ...coverageOf(record.catalogue, { schemaVersion: "paneweft.inventory/1", views: [], examples: [] }, runs), declared: null, inventory: "none" };
  return { ...coverageOf(record.catalogue, record.inventory, runs), inventory: "checked" };
}

async function listTypes(call: Call): Promise<OperationOutcome> {
  const loaded = await loadForRepo(call, call.args.language);
  if (isOutcome(loaded)) return loaded;
  const records = loaded.records;
  const query = typeof call.args.query === "string" ? call.args.query.toLowerCase() : undefined;
  const runs = await lastCaptures(call, call.args.repo as string);
  // every compatible catalogue of the repository is listed (S16); a type two scopes declare is listed once, naming both
  const types = new Map<string, { typeId: string; source: { path: string; symbol: string }; scopes: string[] }>();
  for (const record of records) for (const type of record.catalogue.types) {
    const known = types.get(type.typeId);
    if (known === undefined) types.set(type.typeId, { typeId: type.typeId, source: type.source, scopes: [record.adapter] });
    else known.scopes.push(record.adapter);
  }
  const matched = [...types.values()].filter((type) => query === undefined || type.typeId.toLowerCase().includes(query) || type.source.symbol.toLowerCase().includes(query)).sort((a, b) => compareCodeUnits(a.typeId, b.typeId));
  const many = records.length > 1;
  const items: Item[] = matched.map((type) => {
    const views = [...new Set(records.flatMap((record) => record.catalogue.views.filter((view) => view.typeId === type.typeId).map((view) => view.id)))].sort(compareCodeUnits);
    const examples = [...new Set(records.flatMap((record) => record.catalogue.examples.filter((example) => example.typeId === type.typeId).map((example) => example.id)))].sort(compareCodeUnits);
    return { json: { typeId: type.typeId, source: type.source, views, examples, ...(many ? { scopes: type.scopes } : {}) }, text: `${type.typeId} -> ${type.source.path}:${type.source.symbol}; views=${views.length === 0 ? "none" : views.join(",")}; examples=${examples.length === 0 ? "none" : examples.join(",")}${many ? `; scopes=${type.scopes.join(",")}` : ""}` };
  });
  const scopes = await scopesOf(call, records, runs);
  const first = records[0] as CatalogueRecord;
  const figures = records.map((record) => coverageFigures(record, runs));
  const sum = (pick: (figure: (typeof figures)[number]) => number | null): number | null => (figures.some((figure) => pick(figure) === null) ? null : figures.reduce((total, figure) => total + (pick(figure) as number), 0));
  const combined = { declared: sum((figure) => figure.declared), linked: sum((figure) => figure.linked), exercised: sum((figure) => figure.exercised), passing: sum((figure) => figure.passing), gaps: figures.flatMap((figure) => figure.gaps), inventory: figures.every((figure) => figure.inventory === "checked") ? "checked" : "none" };
  const single = many ? {} : { target: first.catalogue.target, linkedScope: first.catalogue.linkedScope, catalogueDigest: first.catalogue.digest, collectedAt: first.collectedAt };
  return serveListing({ tool: "list_types", completeness: loaded.uncatalogued ? { status: "partial", reason: "no catalogue stored yet" } : { status: "complete" }, ...(loaded.uncatalogued ? { notices: [NO_CATALOGUE_NOTICE(call.args.repo as string)] } : {}), freshness: await mergedFreshness(call, records), unit: "types", total: types.size, items, details: { ...single, scopes, coverage: combined }, query: { tool: "list_types", repo: call.args.repo, language: call.args.language ?? null, query: call.args.query ?? null } }, call);
}

async function lastCaptures(call: Call, repo: string): Promise<TestRun[]> {
  const reader = openV1Reader(call.context.session);
  const runs = await reader.runs();
  if (!runs.ok) return [];
  const loaded: TestRun[] = [];
  for (const entry of runs.value) {
    const record = await committedImport(call.context.session, entry.runId);
    if (record?.repo !== repo) continue;
    const run = await reader.run(entry.runId);
    if (run.ok) loaded.push(run.value.run);
  }
  // F22: run ids come from request ids the agent chooses, so their order says nothing about which run is newest. The order is the time the host
  // recorded the run (`meta.importedAt`, stamped at import; never a clock inside a capture); the id only breaks a tie. Oldest first, newest last.
  return loaded.sort((a, b) => compareCodeUnits(recordedAt(a), recordedAt(b)) || compareCodeUnits(a.runId, b.runId));
}

/** When the host recorded the run (ISO-8601, so code-unit order is time order); "" for a run stored without a stamp, which sorts first. */
const recordedAt = (run: TestRun): string => run.meta?.importedAt ?? "";

/** The scope names a `target` argument may use: the adapter id, the catalogue's package and its target. */
const scopeNames = (record: CatalogueRecord): string[] => [record.adapter, record.catalogue.target.package, ...(record.catalogue.target.target === undefined ? [] : [record.catalogue.target.target])];

async function listViews(call: Call): Promise<OperationOutcome> {
  const loaded = await loadForRepo(call);
  if (isOutcome(loaded)) return loaded;
  const typeId = call.args.type as string;
  const target = call.args.target as string | undefined;
  // S16: `target` selects the scope(s) it names, and the reply says which scope it used; without it every catalogue of the repository answers
  const records = target === undefined ? loaded.records : loaded.records.filter((record) => scopeNames(record).includes(target));
  if (records.length === 0) return failure(call.format, "NOT_FOUND", `no catalogue of repository "${call.args.repo}" is compiled for the target "${target}"; the scopes are: ${loaded.records.map((record) => `${record.adapter} (${scopeNames(record).slice(1).join(", ")})`).join("; ")}`, { details: { targets: loaded.records.flatMap(scopeNames) } });
  const freshness = await mergedFreshness(call, records);
  const runs = await lastCaptures(call, call.args.repo as string);
  const known = records.some((record) => record.catalogue.types.some((type) => type.typeId === typeId));
  const views = new Map<string, Catalogue["views"][number]>();
  for (const record of records) for (const view of record.catalogue.views.filter((candidate) => candidate.typeId === typeId)) if (!views.has(view.id)) views.set(view.id, view);
  const ordered = [...views.values()].sort(viewSortKey);
  const examples = [...new Set(records.flatMap((record) => record.catalogue.examples.filter((example) => example.typeId === typeId).map((example) => example.id)))].sort(compareCodeUnits);
  // F11: the last capture is the newest run in which one of these examples captured something; a run that was cancelled or crashed first has none
  const lastRun = [...runs].reverse().find((run) => run.invocations.some((invocation) => examples.includes(invocation.exampleId) && invocation.capture.captureId !== undefined));
  const items: Item[] = ordered.map((view) => {
    const json = { id: view.id, title: view.title, question: view.question, component: view.component, priority: view.priority, source: view.source, renderer: view.renderer ?? null, exampleIds: examples, lastCapture: lastRun === undefined ? null : { runId: lastRun.runId, snapshotId: `snap-${lastRun.runId}` }, staleReasons: freshness.status === "stale" ? freshness.reasons ?? [] : [] };
    return { json, text: `${view.id} [${view.component}, priority ${view.priority}] ${view.title} -- ${view.question} (${view.source.path}:${view.source.line}); examples=${examples.length === 0 ? "none" : examples.join(",")}; last capture=${lastRun === undefined ? "never" : lastRun.runId}` };
  });
  const notices: string[] = loaded.uncatalogued ? [NO_CATALOGUE_NOTICE(call.args.repo as string)] : [];
  const covered = records.map((record) => `${record.catalogue.linkedScope.join(", ")} (linked scope; target ${record.catalogue.target.target ?? record.catalogue.target.package}, features ${record.catalogue.target.features.join(",") || "none"})`).join("; ");
  if (!known && !loaded.uncatalogued) {
    notices.push(`the type "${typeId}" is not in the ${records.length === 1 ? "catalogue" : "catalogues"} compiled for ${covered}. That is NOT a statement that it has no views: it may live in a target, feature set or module ${records.length === 1 ? "this catalogue" : "these catalogues"} did not cover.`);
    if (freshness.status === "stale") notices.push("the catalogue is outdated: the sources changed after it was compiled; the next collect exports it again, and until then this answer may miss what changed");
  }
  const first = records[0] as CatalogueRecord;
  const single = records.length > 1 ? {} : { linkedScope: first.catalogue.linkedScope, catalogueDigest: first.catalogue.digest };
  return serveListing({ tool: "list_views_for_type", completeness: known ? { status: "complete" } : { status: "partial", reason: "type not in the compiled catalogue" }, freshness, unit: "views", total: ordered.length, items, notices, details: { typeId, ...single, scopes: await scopesOf(call, records, runs) }, query: { tool: "list_views_for_type", repo: call.args.repo, type: typeId, target: target ?? null } }, call);
}

async function listExamples(call: Call): Promise<OperationOutcome> {
  const loaded = await loadForRepo(call);
  if (isOutcome(loaded)) return loaded;
  const records = loaded.records;
  const runs = await lastCaptures(call, call.args.repo as string);
  const catalogues = records.map((record) => record.catalogue);
  const viewType = typeof call.args.view === "string" ? catalogues.flatMap((catalogue) => catalogue.views).find((view) => view.id === call.args.view)?.typeId : undefined;
  const examples = new Map<string, Catalogue["examples"][number]>();
  for (const catalogue of catalogues) for (const example of catalogue.examples) if (!examples.has(example.id)) examples.set(example.id, example);
  const matched = [...examples.values()].filter((example) => (call.args.type === undefined || example.typeId === call.args.type) && (call.args.view === undefined || example.typeId === viewType) && (call.args.tag === undefined || example.claims.includes(call.args.tag) || example.kind === call.args.tag)).sort((a, b) => compareCodeUnits(a.id, b.id));
  const items: Item[] = matched.map((example) => {
    const last = [...runs].reverse().map((run) => run.examples.find((candidate) => candidate.id === example.id)).find((found) => found !== undefined);
    const lastRun = [...runs].reverse().find((run) => run.examples.some((candidate) => candidate.id === example.id));
    const lastOutcome = last === undefined || lastRun === undefined ? null : { runId: lastRun.runId, outcome: last.outcome, verified: last.verified };
    const scope = records.length > 1 ? records.filter((record) => record.catalogue.examples.some((candidate) => candidate.id === example.id)).map((record) => record.adapter) : undefined;
    return { json: { id: example.id, returns: example.typeId, claims: example.claims, kind: example.kind ?? "example", selector: example.selector, composes: example.composes, lastOutcome, ...(scope === undefined ? {} : { scopes: scope }) }, text: `${example.id} -> ${example.typeId}; claims=${example.claims.join(",") || "none"}; ${example.kind ?? "example"}; ${example.selector.runner} ${example.selector.name}; last=${lastOutcome === null ? "never run" : `${lastOutcome.outcome}${lastOutcome.verified ? " verified" : ""} in ${lastOutcome.runId}`}${scope === undefined ? "" : `; scopes=${scope.join(",")}`}` };
  });
  const first = records[0] as CatalogueRecord;
  const single = records.length > 1 ? {} : { linkedScope: first.catalogue.linkedScope, catalogueDigest: first.catalogue.digest };
  return serveListing({ tool: "list_examples", completeness: loaded.uncatalogued ? { status: "partial", reason: "no catalogue stored yet" } : { status: "complete" }, ...(loaded.uncatalogued ? { notices: [NO_CATALOGUE_NOTICE(call.args.repo as string)] } : {}), freshness: await mergedFreshness(call, records), unit: "examples", total: examples.size, items, details: { ...single, scopes: await scopesOf(call, records, runs) }, query: { tool: "list_examples", repo: call.args.repo, type: call.args.type ?? null, view: call.args.view ?? null, tag: call.args.tag ?? null } }, call);
}

// ---- scaffolds (read-only generation) ------------------------------------------------------------------------------------------------

interface Patch { path: string; text: string }
interface ScaffoldPlan {
  patches: Patch[];
  outputTest: Patch;
  registration: string;
  template: string;
  /** TypeScript: the token a new example uses, and where it is declared (`declared` false: the scaffold's own module). */
  token?: { symbol: string; module: string; declared: boolean };
  /** TypeScript, `declared` false: the module that declares the token and nothing else; whatever uses the token must return it too (S12). */
  tokenPatch?: Patch;
}

/** The module specifier that imports `target` (a repository-relative path) from a file in the directory `from`. */
const importFrom = (from: string, target: string): string => {
  const path = relativePath(from, target);
  return path.startsWith(".") ? path : `./${path}`;
};

/** The token the repository declares for `typeId`: the `export const X = defineType(... id: "<typeId>" ...)` of the module that holds the
 * type's catalogued views. Read from the owner's checked-out source (this tool executes nothing); undefined when no module declares one. */
async function declaredToken(adapter: AdapterRecord | undefined, catalogue: Catalogue, typeId: string): Promise<{ symbol: string; module: string } | undefined> {
  if (adapter === undefined) return undefined;
  const root = resolvePath(join(adapter.workspaceRoot, adapter.entry));
  const modules = [...new Set(catalogue.views.filter((view) => view.typeId === typeId).map((view) => view.module ?? view.source.path))];
  const escaped = typeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`export\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*defineType\\s*(?:<[^()]*>)?\\s*\\(\\s*\\{[^}]*?\\bid\\s*:\\s*["'\`]${escaped}["'\`]`);
  for (const module of modules) {
    const path = resolvePath(root, module);
    if (path !== root && !path.startsWith(`${root}/`)) continue;
    const text = await readFile(path, "utf8").catch(() => undefined);
    const match = text === undefined ? null : pattern.exec(text);
    if (match !== null) return { symbol: match[1] as string, module };
  }
  return undefined;
}

function scaffoldView(kind: "cargo" | "vitest", args: { typeId: string; source: { path: string; symbol: string }; question: string; component: "shape" | "list"; claim: string; token?: { symbol: string; module: string } }): ScaffoldPlan {
  const name = slug(args.question);
  const title = args.question.replace(/\?$/, "").slice(0, 60);
  if (kind === "cargo") {
    return {
      template: "rust-views-v1",
      patches: [{ path: args.source.path, text: [
        `// ${args.source.path}: add to the existing \`#[paneweft::views]\` impl of ${args.source.symbol} if there is one (a type has ONE views impl);`,
        "// otherwise add this block. Every use of the SDK stays behind the `paneweft` feature.",
        "#[cfg(feature = \"paneweft\")]",
        `#[paneweft::views(type_id = "${args.typeId}")]`,
        `impl ${args.source.symbol} {`,
        `    #[paneweft::view(id = "${slug(args.source.symbol)}.${name}", title = ${JSON.stringify(title)}, component = "${args.component}", priority = 50, question = ${JSON.stringify(args.question)})]`,
        `    fn ${name}_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {`,
        "        // TODO: read the receiver and select the fields that answer the question; open the type's definition first, do not guess field names.",
        `        Ok(paneweft::View::unsupported("TODO: implement the projection for: ${args.question.replace(/"/g, "'")}"))`,
        "    }",
        "}",
        "",
      ].join("\n") }],
      outputTest: { path: args.source.path, text: [
        "#[cfg(all(test, feature = \"paneweft\"))]",
        "mod tests {",
        "    // WHY: the view must answer the question with independently expected values; this fails until it is implemented.",
        `    // CLAIM: ${args.claim}`,
        "    #[test]",
        `    fn ${name}_answers_the_question() {`,
        `        assert!(false, "TODO: write the expected fields for: ${args.question.replace(/"/g, "'")}, then implement the view");`,
        "    }",
        "}",
        "",
      ].join("\n") },
      registration: "Rust: nothing to import; `#[paneweft::views]` registers the descriptor with linkme. Cargo.toml: `[features] paneweft = [\"dep:paneweft\"]` and `[dependencies.paneweft] path = \"vendor/paneweft/paneweft\"  optional = true`, where `vendor/paneweft` is a copy of the SDK inside this repository (`node <paneweft checkout>/scripts/vendor-rust-sdk.mjs vendor/paneweft`): Cargo reads an optional path dependency even when its feature is off, so a path outside the repository breaks every plain build (and a Nix build) where that checkout is absent. Make sure the test binary calls `paneweft::test_adapter!();` once, then collect the example (the collection exports the catalogue itself).",
    };
  }
  const view = (token: string): string[] => [
    `export const ${name} = ${token}.view({`,
    `  id: ${JSON.stringify(`${slug(args.source.symbol)}.${name}`)},`,
    `  title: ${JSON.stringify(title)},`,
    `  question: ${JSON.stringify(args.question)},`,
    "  priority: 50,",
    `  component: "${args.component}",`,
    "  render(value, view) {",
    "    // TODO: select the fields that answer the question; read the type's definition, do not guess property names.",
    `    return view.unsupported(${JSON.stringify(`TODO: implement the projection for: ${args.question}`)});`,
    "  },",
    "});",
    "",
  ];
  const outputTest: Patch = { path: "tests/views.paneweft.test.ts", text: [
    "import { assert, it } from \"vitest\";",
    "",
    "// WHY: the view must answer the question with independently expected values; this fails until it is implemented.",
    `// CLAIM: ${args.claim}`,
    `it(${JSON.stringify(`${name} answers the question`)}, () => {`,
    `  assert.fail(${JSON.stringify(`TODO: write the expected fields for: ${args.question}, then implement the view`)});`,
    "});",
    "",
  ].join("\n") };
  if (args.token !== undefined) {
    // the repository already declares the token for this type: extend the module that holds it
    return {
      template: "ts-token-view-v1",
      patches: [{ path: args.token.module, text: [`// ${args.token.module}: append to the existing module; \`${args.token.symbol}\` is the token it already declares for ${args.typeId}.`, ...view(args.token.symbol)].join("\n") }],
      token: { ...args.token, declared: true },
      outputTest,
      registration: `TypeScript: add \`${name}\` to the \`views\` of the entry for "${args.token.module}" in paneweft.views.ts (the module is already part of the manifest), then collect the example (the collection exports the catalogue itself).`,
    };
  }
  // no module declares a token for the type: the patch is a whole module that declares its own and imports only what exists
  const modulePath = join(dirname(args.source.path), `${args.source.symbol}.paneweft.ts`);
  const relative = relativePath(dirname(modulePath), args.source.path);
  const tokenName = `${args.source.symbol}Token`;
  const declaration = [
    `// Development-only instrumentation of ${args.source.symbol}; never import it from a production entry point.`,
    "import { defineType } from \"@paneweft/sdk\";",
    `import type { ${args.source.symbol} } from ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};`,
    "",
    `export const ${tokenName} = defineType<${args.source.symbol}>({`,
    `  id: ${JSON.stringify(args.typeId)},`,
    `  source: { path: ${JSON.stringify(args.source.path)}, symbol: ${JSON.stringify(args.source.symbol)} },`,
    "});",
    "",
  ];
  return {
    template: "ts-token-view-v1",
    patches: [{ path: modulePath, text: [...declaration, ...view(tokenName)].join("\n") }],
    token: { symbol: tokenName, module: modulePath, declared: false },
    tokenPatch: { path: modulePath, text: declaration.join("\n") },
    outputTest,
    registration: `TypeScript: add an entry for "${modulePath}" to paneweft.views.ts with \`types: [${tokenName}]\` and \`views: [${name}]\`, then collect the example (the collection exports the catalogue itself).`,
  };
}

function resolveType(catalogue: Catalogue, requested: string): { typeId: string; source: { path: string; symbol: string } } | { candidates: Array<{ typeId: string; source: { path: string; symbol: string } }> } {
  const exact = catalogue.types.find((type) => type.typeId === requested);
  if (exact !== undefined) return exact;
  const bare = catalogue.types.filter((type) => type.source.symbol === requested || type.typeId.endsWith(`::${requested}`)).sort((a, b) => compareCodeUnits(a.typeId, b.typeId));
  return bare.length === 1 ? (bare[0] as (typeof catalogue.types)[number]) : { candidates: bare };
}

/** Pages `patches` by byte slices: every slice is data, so a part is never a clipped patch that looks complete. */
function servePatches(call: Call, spec: Omit<ReplySpec, "items"> & { details: Json }, patches: Patch[]): OperationOutcome {
  const { format, budget } = call;
  const query = queryDigest(spec.query);
  const content = queryDigest(patches).slice(0, 8);
  /** What the text form shows beyond the header (S12): every patch, the output test, the registration step and the collect recipe. */
  const textOf = (shown: Array<{ path: string; text: string; note?: string }>, withTail: boolean): string[] => {
    const lines: string[] = [];
    for (const patch of shown) lines.push(`patch ${patch.path}${patch.note ?? ""}:`, patch.text.replace(/\n$/, ""));
    if (withTail) {
      const details = spec.details as { outputTest?: Patch; registration?: string; recipe?: { command: string } };
      if (details.outputTest !== undefined) lines.push(`output test ${details.outputTest.path}:`, details.outputTest.text.replace(/\n$/, ""));
      if (details.registration !== undefined) lines.push(`registration: ${details.registration}`);
      if (details.recipe !== undefined) lines.push(`recipe: ${details.recipe.command}`);
    }
    return lines;
  };
  const whole = { ...spec, items: [] as Item[], details: { ...spec.details, patches }, textLines: textOf(patches, true) };
  const wholeBody = renderReply(whole, format, 0, 0, null);
  let position = { index: 0, offset: 0 };
  if (call.cursor !== undefined) {
    const decoded = decodeCursor(call.cursor);
    if (!decoded.ok) return failure(format, "CURSOR_INVALID", "the cursor is not a cursor this server issued");
    if (decoded.query !== query) return failure(format, "CURSOR_MISMATCH", "the cursor belongs to a different query");
    if (decoded.content !== content) return failure(format, "CURSOR_STALE", "the patch changed since this cursor was issued");
    position = { index: decoded.position.index, offset: decoded.position.offset };
  } else if (bytes(wholeBody) <= budget) {
    return { ok: true, format, body: wholeBody, payload: JSON.parse(renderReply({ ...whole }, "json", 0, 0, null)), cursor: null };
  }
  const file = patches[position.index];
  if (file === undefined) return failure(format, "CURSOR_INVALID", "the cursor points outside the patch");
  const buffer = Buffer.from(file.text, "utf8");
  const total = patches.reduce((sum, patch) => sum + bytes(patch.text), 0);
  const make = (size: number): { body: string; payload: unknown; cursor: string | null } => {
    let end = Math.min(buffer.length, position.offset + size);
    while (end < buffer.length && ((buffer[end] as number) & 0xc0) === 0x80) end -= 1;
    const nextIndex = end >= buffer.length ? position.index + 1 : position.index;
    const nextOffset = end >= buffer.length ? 0 : end;
    const cursor = nextIndex < patches.length ? encodeCursor(query, { index: nextIndex, offset: nextOffset, ...(nextOffset > 0 ? { format } : {}) }, content) : null;
    const slice = buffer.subarray(position.offset, end).toString("utf8");
    const sliceSize = Math.max(1, size);
    const ofParts = Math.max(2, Math.ceil(total / sliceSize));
    const part = Math.min(ofParts, Math.floor((patches.slice(0, position.index).reduce((sum, patch) => sum + bytes(patch.text), 0) + position.offset) / sliceSize) + 1);
    const details = { ...spec.details, patches: [{ path: file.path, text: slice, part, ofParts }] };
    const reply = { ...spec, items: [] as Item[], details, textLines: textOf([{ path: file.path, text: slice, note: ` (part ${part} of ${ofParts})` }], position.index === 0 && position.offset === 0) };
    return { body: renderReply(reply, format, 0, 0, cursor), payload: JSON.parse(renderReply(reply, "json", 0, 0, cursor)), cursor };
  };
  let size = Math.max(64, budget - 1500);
  let page = make(size);
  while (bytes(page.body) > budget && size > 16) {
    size = Math.floor(size * 0.85);
    page = make(size);
  }
  if (bytes(page.body) > budget) return failure(format, "BUDGET_TOO_SMALL", `maxBytes ${budget} cannot carry the mandatory part of this reply`, { details: { minimumBytes: Math.min(32768, bytes(page.body)) } });
  return { ok: true, format, body: page.body, payload: page.payload, cursor: page.cursor };
}

async function scaffold(call: Call, tool: "scaffold_view" | "scaffold_example"): Promise<OperationOutcome> {
  const loaded = await loadForRepo(call);
  if (isOutcome(loaded)) return loaded;
  const requested = call.args.type as string;
  const record = (loaded.records.find((candidate) => !("candidates" in resolveType(candidate.catalogue, requested))) ?? loaded.records[0]) as CatalogueRecord;
  const resolved = resolveType(record.catalogue, requested);
  const notices: string[] = ["this reply writes nothing: apply the patch with your normal code editor"];
  let typeId: string;
  let source: { path: string; symbol: string };
  if ("candidates" in resolved) {
    if (resolved.candidates.length > 1) return failure(call.format, "UNRESOLVED_TARGET", `"${requested}" matches ${resolved.candidates.length} catalogued types: name one by its type id`, { details: { candidates: resolved.candidates } });
    if (call.args.source === undefined) return failure(call.format, "UNRESOLVED_TARGET", `"${requested}" is not in the catalogue${loaded.uncatalogued ? " (none is stored yet)" : ""}; pass an explicit source {path, symbol} as a candidate: the compiler validates it, and the first collect exports the catalogue that then lists it`, { details: { candidates: [] } });
    typeId = requested;
    source = call.args.source as { path: string; symbol: string };
    notices.push(`the type "${typeId}" is not catalogued: ${source.path}:${source.symbol} is taken as a candidate only; the compiler must validate it before the view counts`);
  } else {
    typeId = resolved.typeId;
    source = resolved.source;
  }
  const adapters = await adaptersOf(call.context.sessionDir);
  const adapter = adapters.find((candidate) => candidate.repo === record.repo && candidate.id === record.adapter) ?? adapters.find((candidate) => candidate.repo === record.repo);
  const kind = adapter?.kind ?? record.catalogue.target.runner;
  const question = tool === "scaffold_view" ? (call.args.question as string) : `Example of ${typeId}`;
  const claim = `${slug(source.symbol).toUpperCase().slice(0, 12)}-1`;
  const token = kind === "vitest" ? await declaredToken(adapter, record.catalogue, typeId) : undefined;
  const plan = scaffoldView(kind, { typeId, source, question, component: (call.args.component as "shape" | "list" | undefined) ?? "shape", claim, ...(token === undefined ? {} : { token }) });
  if (tool === "scaffold_example") {
    const example = (call.args.example as string | undefined) ?? `${slug(source.symbol)}.new`;
    if (kind === "cargo") {
      plan.patches = [{ path: plan.outputTest.path, text: `#[cfg(all(test, feature = "paneweft"))]\nmod examples {\n    // the example returns a value of the type declared in the module around this one; adjust the path if the type is declared deeper\n    use super::${source.symbol};\n\n    #[paneweft::example(id = ${JSON.stringify(example)}, claims = [${JSON.stringify(claim)}])]\n    fn ${slug(example)}() -> ${source.symbol} {\n        // TODO: build the value with the real constructor; do not invent fields.\n        unimplemented!("TODO: construct ${source.symbol}")\n    }\n}\n` }];
      plan.registration = "Rust: nothing to import; `#[paneweft::example]` registers the example descriptor with linkme. Cargo.toml: `[features] paneweft = [\"dep:paneweft\"]` and `[dependencies.paneweft] path = \"vendor/paneweft/paneweft\"  optional = true`, where `vendor/paneweft` is a copy of the SDK inside this repository (`node <paneweft checkout>/scripts/vendor-rust-sdk.mjs vendor/paneweft`): Cargo reads an optional path dependency even when its feature is off, so a path outside the repository breaks every plain build (and a Nix build) where that checkout is absent. Make sure the test binary calls `paneweft::test_adapter!();` once, then collect the example by its id: the collection exports the catalogue itself.";
    } else {
      // S12: the example brings everything it imports. The token declaration the plan proposed (when the repository declares none) is returned
      // WITH the example, the example is registered in the manifest (not the view the plan shared), and a test file runs it.
      const token = plan.token as NonNullable<ScaffoldPlan["token"]>;
      const name = slug(example);
      const examplePath = `tests/${name}.examples.ts`;
      const testPath = `tests/${name}.paneweft.test.ts`;
      const exampleText = `import { example } from "@paneweft/sdk";\nimport { ${token.symbol} } from ${JSON.stringify(importFrom("tests", token.module))};${token.declared ? "" : " // declared by the first patch of this reply"}\n\nexport const ${name} = example({ id: ${JSON.stringify(example)}, type: ${token.symbol}, claims: [${JSON.stringify(claim)}], run(cx) {\n  // TODO: build the value with the real code, then record a check\n  cx.check(${JSON.stringify(claim)}, () => { throw new Error("TODO: write the expected assertion"); });\n  throw new Error("TODO: construct ${source.symbol}");\n} });\n`;
      plan.patches = [...(plan.tokenPatch === undefined ? [] : [plan.tokenPatch]), { path: examplePath, text: exampleText }];
      plan.outputTest = { path: testPath, text: [
        "import { exampleTest } from \"@paneweft/sdk/vitest\";",
        `import { ${name} } from ${JSON.stringify(`./${name}.examples.ts`)};`,
        "",
        "// WHY: the example must build the value with the real code and record checks with independently expected values; this fails until it does.",
        `// CLAIM: ${claim}`,
        `exampleTest(${name});`,
        "",
      ].join("\n") };
      plan.registration = [
        `TypeScript: in paneweft.views.ts import { ${name} } from ${JSON.stringify(`./${examplePath}`)} and add { path: ${JSON.stringify(examplePath)}, examples: [${name}] } to the modules of the manifest.`,
        ...(token.declared ? [] : [`The token is new: also import { ${token.symbol} } from ${JSON.stringify(`./${token.module}`)} and add { path: ${JSON.stringify(token.module)}, types: [${token.symbol}] } to the modules.`]),
        `${testPath} runs the example under vitest. Then collect the example: the collection exports the catalogue itself.`,
      ].join(" ");
    }
  }
  const recipe = { command: `paneweft collect --request-id <id> --repo ${record.repo} --adapter ${record.adapter} --example <example-id>`, adapter: record.adapter };
  return servePatches(call, { tool, completeness: { status: "complete" }, freshness: await scopeFreshness(call, record), unit: "patches", total: plan.patches.length, notices, query: { tool, repo: call.args.repo, type: requested, question: call.args.question ?? null, component: call.args.component ?? null, example: call.args.example ?? null }, details: { typeId, source, template: plan.template, outputTest: plan.outputTest, registration: plan.registration, recipe } }, plan.patches);
}

// ---- collection ---------------------------------------------------------------------------------------------------------------------

function jobItem(view: Json): Item {
  const parts = [`job ${view.requestId}: ${view.state}`, view.runId === null ? "no run yet" : `run ${view.runId}`, `qex ${view.qexId ?? "-"}`];
  if (view.collectionStatus !== undefined) parts.push(`collection ${view.collectionStatus}`);
  if (view.snapshotIds?.length > 0) parts.push(`snapshots ${view.snapshotIds.join(",")}`);
  if (view.diagnosticIds?.length > 0) parts.push(`diagnostics ${view.diagnosticIds.join(",")}`);
  if (view.indeterminate !== undefined) parts.push(`indeterminate: ${view.indeterminate.evidence.join("; ")}`);
  if (view.counts !== undefined) parts.push(`counts ${Object.entries(view.counts).map(([key, value]) => `${key}=${value}`).join(" ")}`);
  if (view.limits?.clamped?.length > 0) parts.push(`limits clamped: ${view.limits.clamped.map((name: string) => `${name}=${view.limits.effective[name]} (asked ${view.limits.requested[name]})`).join(", ")}`);
  const lines = [parts.join("; ")];
  if (view.log !== undefined) lines.push(`log: ${JSON.stringify(view.log.text)}${view.log.cursor === null ? "" : ` (log cursor ${view.log.cursor})`}`);
  return { json: view, text: lines.join("\n") };
}

function wrapService(call: Call, tool: string, result: { ok: true; value: Json } | { ok: false; error: OperationError }, unit: string): OperationOutcome {
  if (!result.ok) return fromError(call.format, result.error);
  return serveListing({ tool, completeness: { status: "complete" }, freshness: { status: "not-applicable" }, unit, total: 1, items: [jobItem(result.value)], query: { tool, id: result.value.requestId ?? call.args.job } }, call);
}

async function collect(call: Call): Promise<OperationOutcome> {
  if (call.context.jobs === null) return failure(call.format, "SESSION_REQUIRED", "collect needs a session with a job service");
  const { requestId, repo, adapter, examples, views, limits } = call.args;
  return wrapService(call, "collect", await call.context.jobs.collect({ requestId, repo, adapter, examples, ...(views === undefined ? {} : { views }), ...(limits === undefined ? {} : { limits }) }), "jobs");
}

async function collectionStatus(call: Call): Promise<OperationOutcome> {
  if (call.context.jobs === null) return failure(call.format, "SESSION_REQUIRED", "collection_status needs a session with a job service");
  return wrapService(call, "collection_status", await call.context.jobs.status(call.args.job, { ...(call.args.waitSeconds === undefined ? {} : { waitSeconds: call.args.waitSeconds }), ...(call.args.logCursor === undefined ? {} : { logCursor: call.args.logCursor, maxLogBytes: 2048 }) }), "jobs");
}

async function cancelCollection(call: Call): Promise<OperationOutcome> {
  if (call.context.jobs === null) return failure(call.format, "SESSION_REQUIRED", "cancel_collection needs a session with a job service");
  const result = await call.context.jobs.cancel(call.args.job);
  if (!result.ok) return fromError(call.format, result.error);
  const value = { job: call.args.job, ...result.value };
  return serveListing({ tool: "cancel_collection", completeness: { status: "complete" }, freshness: { status: "not-applicable" }, unit: "jobs", total: 1, items: [{ json: value, text: `job ${call.args.job}: ${value.outcome}; state ${value.state}; qex actions ${value.qexActions.join(",") || "none"}${value.collectionStatus === undefined ? "" : `; collection ${value.collectionStatus}`}` }], query: { tool: "cancel_collection", job: call.args.job } }, call);
}

// ---- results and failures -------------------------------------------------------------------------------------------------------------

function viewerUrl(sessionDir: string, key: { viewId: string; snapshotId: string }): string | null {
  try {
    const server = JSON.parse(readFileSync(join(sessionDir, "server.json"), "utf8")) as { origin?: string; token?: string; pid?: number };
    if (typeof server.origin !== "string" || typeof server.token !== "string" || typeof server.pid !== "number") return null;
    process.kill(server.pid, 0);
    return `${server.origin}/#token=${server.token}&view=${encodeURIComponent(key.viewId)}&snapshot=${encodeURIComponent(key.snapshotId)}`;
  } catch {
    return null;
  }
}

const objectNumber = (objectId: string): number => Number(objectId.replace(/\D+/g, "")) || 0;

async function viewResult(call: Call): Promise<OperationOutcome> {
  const { session, sessionDir, jobs } = call.context;
  let runId = call.args.run as string | undefined;
  if (runId === undefined) {
    const status = jobs === null || call.args.job === undefined ? undefined : await jobs.status(call.args.job as string);
    if (status === undefined) return failure(call.format, "INVALID_ARGUMENT", "view_result needs a run or a job", { errors: [{ code: "REQUIRED", pointer: "/run", constraint: "run or job", hint: "Pass the run id (run-<request id>) or the job id returned by collect." }] });
    if (!status.ok) return fromError(call.format, status.error);
    runId = status.value.runId ?? undefined;
    if (runId === undefined) return failure(call.format, "NOT_FOUND", `job "${call.args.job}" has no run yet`);
  }
  const reader = openV1Reader(session);
  const stored = await reader.run(runId);
  if (!stored.ok) return fromError(call.format, stored.error);
  const snapshotId = stored.value.snapshotId;
  const index = await session.listViewIndex(snapshotId);
  const wanted = call.args.view as string;
  const observation = call.args.observation as string | undefined;
  const wantedExample = call.args.example as string | undefined;
  const run = stored.value.run;
  let matches = index.filter((entry) => entry.viewDefinitionId === wanted || entry.viewId === wanted);
  const objectOf = (entry: (typeof index)[number]): string => entry.entity.id.slice(entry.entity.id.lastIndexOf(".") + 1);
  const captureOf = (entry: (typeof index)[number]): string => entry.entity.id.slice(0, entry.entity.id.lastIndexOf("."));
  const invocationOf = (entry: (typeof index)[number]): TestRun["invocations"][number] | undefined => run.invocations.find((invocation) => invocation.capture.captureId === captureOf(entry));
  const orderOf = (entry: (typeof index)[number]): number => run.invocations.findIndex((invocation) => invocation.capture.captureId === captureOf(entry));
  const examplesOfRun = [...new Set(run.invocations.map((invocation) => invocation.exampleId))].sort(compareCodeUnits);
  if (observation !== undefined) matches = matches.filter((entry) => objectOf(entry) === observation || entry.viewId === observation || entry.entity.id === observation);
  if (matches.length === 0) return failure(call.format, "NOT_FOUND", `run "${runId}" has no stored view "${wanted}"${observation === undefined ? "" : ` for ${observation}`}`, { details: { candidates: [...new Set(index.map((entry) => entry.viewDefinitionId))].sort(compareCodeUnits) } });
  if (wantedExample !== undefined) {
    // F8: object ids restart in every capture, so the example is the selector that names one result. Of the example's captures the final
    // attempt's wins, then a top-level call over a nested one.
    if (!examplesOfRun.includes(wantedExample)) return failure(call.format, "NOT_FOUND", `run "${runId}" holds no example "${wantedExample}": its examples are ${examplesOfRun.join(", ")}`, { details: { examples: examplesOfRun } });
    const own = matches.filter((entry) => invocationOf(entry)?.exampleId === wantedExample);
    if (own.length === 0) return failure(call.format, "NOT_FOUND", `example "${wantedExample}" of run "${runId}" captured no stored view "${wanted}"`, { details: { examples: [...new Set(matches.map((entry) => invocationOf(entry)?.exampleId).filter((id): id is string => id !== undefined))].sort(compareCodeUnits) } });
    const final = run.examples.find((candidate) => candidate.id === wantedExample)?.final;
    const finalOnes = own.filter((entry) => invocationOf(entry)?.id === final);
    const topLevel = (finalOnes.length > 0 ? finalOnes : own).filter((entry) => invocationOf(entry)?.parent === null);
    matches = topLevel.length > 0 ? topLevel : finalOnes.length > 0 ? finalOnes : own;
  }
  matches.sort((a, b) => objectNumber(objectOf(a)) - objectNumber(objectOf(b)) || orderOf(a) - orderOf(b));
  if (matches.length > 1 && observation === undefined && wantedExample === undefined) {
    // The selected (top-level) example's own capture wins over the captures of the examples it composed: when exactly one match was
    // published by an invocation nobody called, that is the answer to "what did the example I asked for show".
    const topLevel = matches.filter((entry) => invocationOf(entry)?.parent === null);
    if (topLevel.length === 1) matches = topLevel;
  }
  if (matches.length > 1) {
    const candidates = matches.map((entry) => ({ object: objectOf(entry), storedViewId: entry.viewId, view: entry.viewId, exampleId: invocationOf(entry)?.exampleId ?? null, nested: invocationOf(entry)?.parent !== null && invocationOf(entry)?.parent !== undefined, label: entry.title }));
    const exampleChoices = [...new Set(candidates.map((candidate) => candidate.exampleId).filter((id): id is string => id !== null))];
    const sameExample = wantedExample !== undefined || exampleChoices.length < candidates.length;
    const hint = sameExample
      ? `Object ids restart in every capture, so ${candidates[0]?.object} does not pick one. Pass the stored view id as view: ${candidates.slice(0, 4).map((candidate) => candidate.storedViewId).join(" | ")}.`
      : `Object ids restart in every capture, so ${candidates[0]?.object} does not pick one. Pass example (one of ${exampleChoices.join(", ")}) or the stored view id as view (one of ${candidates.slice(0, 4).map((candidate) => candidate.storedViewId).join(" | ")}).`;
    return failure(call.format, "UNRESOLVED_TARGET", `${matches.length} stored views match "${wanted}": ${hint}`, { errors: [{ code: "CONSTRAINT", pointer: sameExample ? "/view" : "/example", constraint: "one stored view", hint }], details: { candidates } });
  }
  const entry = matches[0] as (typeof index)[number];
  const loaded = await session.getView({ viewId: entry.viewId, snapshotId });
  if (!loaded.ok) return fromError(call.format, loaded.error);
  // the stored envelope holds the first page of a list; the rows of its stored pages are read back so that the continuation reaches all of them
  const paged = await withStoredPages(session, loaded.value.envelope);
  if (!paged.ok) return fromError(call.format, paged.error);
  const envelope: Envelope = paged.value;
  const data = envelope.data as Json;
  const items: Item[] = [];
  if (envelope.completeness.status === "unsupported") {
    // Unsupported views have a reason and deliberately have no component data.
  } else if (envelope.component === "list") {
    for (const row of data.rows as Json[]) {
      // a stored first page is checked by the host when it is imported, a stored page when it is read; a row that is neither is storage damage
      if (typeof row !== "object" || row === null || typeof row.cells !== "object" || row.cells === null) return failure(call.format, "STORAGE_CORRUPT", `the stored view "${entry.viewId}" of run "${runId}" holds a row that is not a row with cells`, { details: { runId, storedViewId: entry.viewId } });
      const cells = row.cells as Record<string, unknown>;
      items.push({ json: { id: row.id, cells, entity: row.entity ?? null, provenance: row.provenance }, text: `${row.id}: ${Object.entries(cells).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" | ")}${row.entity === undefined ? "" : ` -> ${row.entity.kind}:${row.entity.id}`}; ${row.provenance}` });
    }
  } else if (envelope.component === "shape") {
    for (const field of data.fields as Json[]) items.push({ json: { id: field.id, path: field.path, type: field.type, example: field.example ?? null, provenance: field.provenance }, text: `${field.path}: ${field.type}${field.example === undefined ? "" : ` = ${JSON.stringify(field.example)}`}; ${field.provenance}` });
  }
  const record = await committedImport(session, runId);
  const adapter = (await adaptersOf(sessionDir!)).find((candidate) => candidate.repo === record?.repo && candidate.kind === stored.value.run.runner.id);
  const freshness = (await judgeRun({ session, sessionDir: sessionDir! }, record?.repo ?? "", stored.value.run)).freshness;
  const completeness = envelope.completeness.status === "unsupported" ? { status: "unsupported" as const, reason: envelope.completeness.reason } : envelope.completeness.status === "partial" ? { status: "partial" as const, reason: envelope.completeness.gaps.map((gap) => gap.reason).join("; ").slice(0, 400) } : { status: "complete" as const };
  const invocation = invocationOf(entry);
  const example = invocation === undefined ? undefined : { id: invocation.exampleId, invocation: invocation.id, nested: invocation.parent !== null };
  const details = {
    runId,
    snapshotId,
    storedViewId: entry.viewId,
    component: envelope.component,
    title: envelope.title,
    question: envelope.question,
    objects: [objectOf(entry)],
    entity: entry.entity,
    origin: stored.value.origin,
    provenance: [...new Set(items.map((item) => item.json.provenance))],
    viewerUrl: viewerUrl(sessionDir!, { viewId: entry.viewId, snapshotId }),
    storedPages: envelope.completeness.status === "partial" ? envelope.completeness.gaps.filter((gap) => gap.id === "stored-pages").map((gap) => gap.reason) : [],
    example: example ?? null,
    recollect: example === undefined ? null : { command: `paneweft collect --request-id <new-id> --repo ${record?.repo ?? "<repo>"} --adapter ${adapter?.id ?? stored.value.run.runner.id} --example ${example.id}` },
  };
  const head = [`view ${entry.viewId} (${envelope.component}) of ${runId}: ${envelope.title} -- ${envelope.question}`, `origin ${details.origin}; object ${details.objects[0]}; viewer ${details.viewerUrl ?? "not running"}`];
  return serveListing({ tool: "view_result", completeness, freshness: { ...freshness, scope: `run ${runId}` }, unit: envelope.component === "list" ? "rows" : "fields", total: items.length, items, details: { ...details, text: head }, query: { tool: "view_result", runId, view: wanted, observation: observation ?? null } }, call);
}

/** Every stored diagnostic called `id` (a bare id), or the one `<runId>:<id>` names. A job's diagnostics are those of its run; the stored
 * captures hold the diagnostics the SDK recorded. */
async function findDiagnostics(call: Call, requested: string): Promise<Array<{ diagnostic: Diagnostic; runId: string }>> {
  const { session, sessionDir } = call.context;
  const { runId: wanted, id } = splitDiagnosticId(requested);
  const found: Array<{ diagnostic: Diagnostic; runId: string }> = [];
  const jobsDir = join(sessionDir!, "jobs");
  const seen = new Set<string>();
  for (const name of (await readdir(jobsDir).catch(() => [])).sort()) {
    const runId = `run-${name}`;
    if (wanted !== null && wanted !== runId) continue;
    const diagnostics = await readJsonFile<Diagnostic[]>(join(jobsDir, name, "diagnostics.json"));
    const hit = diagnostics?.find((candidate) => candidate.id === id);
    if (hit !== undefined) {
      found.push({ diagnostic: hit, runId });
      seen.add(runId);
    }
  }
  const runs = await openV1Reader(session).runs();
  if (runs.ok) {
    for (const entry of runs.value) {
      if ((wanted !== null && wanted !== entry.runId) || seen.has(entry.runId)) continue;
      const record = await committedImport(session, entry.runId);
      for (const captureId of record?.captureIds ?? []) {
        const graph = await readJsonFile<{ diagnostics: Diagnostic[] }>(captureFile(session, entry.runId, captureId));
        const hit = graph?.diagnostics.find((candidate) => candidate.id === id);
        if (hit !== undefined) {
          found.push({ diagnostic: hit, runId: entry.runId });
          break;
        }
      }
    }
  }
  return found;
}

async function explainFailure(call: Call): Promise<OperationOutcome> {
  const requested = call.args.diagnostic as string;
  const matches = await findDiagnostics(call, requested);
  if (matches.length === 0) return failure(call.format, "NOT_FOUND", `no stored diagnostic "${requested}": diagnostic ids come from collection_status (qualified by their run, run-<id>:<diagnostic>)`);
  if (matches.length > 1) return failure(call.format, "UNRESOLVED_TARGET", `${matches.length} runs hold a diagnostic "${requested}": name one with its run, <runId>:${requested}`, { details: { candidates: matches.map((match) => qualifyDiagnosticId(match.runId, match.diagnostic.id)) } });
  const { diagnostic, runId } = matches[0] as { diagnostic: Diagnostic; runId: string };
  const record = await committedImport(call.context.session, runId);
  const selector = diagnostic.exampleId === undefined ? null : { examples: [diagnostic.exampleId], ...(diagnostic.viewId === undefined ? {} : { views: [diagnostic.viewId] }) };
  const adapter = (await adaptersOf(call.context.sessionDir)).find((candidate) => candidate.repo === record?.repo);
  const repeat = selector === null ? null : { selector, command: `paneweft collect --request-id <new-id> --repo ${record?.repo ?? adapter?.repo ?? "<repo>"} --adapter ${adapter?.id ?? "<adapter>"} --example ${diagnostic.exampleId}` };
  const qualifiedId = qualifyDiagnosticId(runId, diagnostic.id);
  const json = { ...diagnostic, qualifiedId, basis: "stored-diagnostic", runId, selector, repeat };
  const text = [`${qualifiedId} [${diagnostic.category}] ${diagnostic.message}`, ...(diagnostic.viewId ? [`view: ${diagnostic.viewId}`] : []), ...(diagnostic.exampleId ? [`example: ${diagnostic.exampleId}`] : []), ...(diagnostic.source ? [`source: ${diagnostic.source.path}:${diagnostic.source.line}${diagnostic.source.column === undefined ? "" : `:${diagnostic.source.column}`}`] : []), ...(diagnostic.pointer ? [`pointer: ${diagnostic.pointer}`] : []), ...(diagnostic.invariant ? [`invariant: ${diagnostic.invariant}`] : []), ...(diagnostic.expected !== undefined ? [`expected: ${JSON.stringify(diagnostic.expected)}`] : []), ...(diagnostic.actual !== undefined ? [`actual: ${JSON.stringify(diagnostic.actual)}`] : []), ...(diagnostic.stderrSlice ? [`stderr: ${JSON.stringify(diagnostic.stderrSlice)}`] : []), `next: ${diagnostic.nextAction}`, ...(repeat ? [`repeat: ${repeat.command}`] : [])];
  return serveListing({ tool: "explain_failure", completeness: { status: "complete" }, freshness: { status: "not-applicable" }, unit: "diagnostics", total: 1, items: [{ json, text: text.join("\n") }], notices: ["evidence from the stored artifacts, not a model's diagnosis; nothing was executed"], query: { tool: "explain_failure", diagnostic: qualifiedId } }, call);
}

// ---- dispatch ---------------------------------------------------------------------------------------------------------------------------

function validateArguments(name: string, args: unknown): ValidationIssue[] {
  const record = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
  if (record === undefined) return [{ code: "TYPE", pointer: "", constraint: "type: object", hint: "Pass the arguments as one JSON object." }];
  const { maxBytes: _budget, ...rest } = record;
  const issues = validateAgainstV1(`urn:paneweft:schema:tool:${name}:1`, rest);
  return issues.map((issue) => ({ ...issue, code: issue.constraint.startsWith("additionalProperties") ? "UNKNOWN_PROPERTY" : issue.constraint.startsWith("required") ? "REQUIRED" : issue.constraint.startsWith("pattern") ? "PATTERN" : issue.constraint.startsWith("type") ? "TYPE" : issue.constraint.startsWith("enum") ? "ENUM" : "CONSTRAINT" }));
}

/** Never throws; failures are outcomes. Operation order as v0: unknown tool, SESSION_REQUIRED, argument validation, target lookup,
 * budget. */
export async function executeV1Operation(context: V1Context, name: string, args: unknown): Promise<OperationOutcome> {
  const record = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const format: ReplyFormat = record.format === "json" ? "json" : "text";
  if (!(V1_TOOL_NAMES as readonly string[]).includes(name)) return failure(format, "UNKNOWN_OPERATION", `unknown operation "${name}"; the operations are ${V1_TOOL_NAMES.join(", ")}`);
  if (context.session === null || context.sessionDir === null) return failure(format, "SESSION_REQUIRED", `${name} needs a session; pass --session DIR (or set PANEWEFT_SESSION) / start paneweft mcp with one`);
  const issues = validateArguments(name, args);
  const requested = record.maxBytes;
  if (requested !== undefined && (typeof requested !== "number" || !Number.isInteger(requested))) issues.push({ code: "TYPE", pointer: "/maxBytes", constraint: "type: integer", hint: "maxBytes is an integer from 2048 to 32768." });
  if (issues.length > 0) return failure(format, "INVALID_ARGUMENT", `the arguments of ${name} are invalid: ${issues[0]?.code} at "${issues[0]?.pointer}"`, { errors: issues });
  if (typeof requested === "number" && requested < 2048) return failure(format, "BUDGET_TOO_SMALL", `maxBytes ${requested} is below the 2048 bytes needed for the mandatory part of this reply`, { details: { minimumBytes: 2048 } });
  const budget = typeof requested === "number" ? Math.min(32768, requested) : 8192;
  const call: Call = { context: { session: context.session, sessionDir: context.sessionDir, jobs: context.jobs }, args: record, format, budget, cursor: typeof record.cursor === "string" ? record.cursor : undefined };
  try {
    switch (name as V1ToolName) {
      case "list_types": return await listTypes(call);
      case "list_views_for_type": return await listViews(call);
      case "list_examples": return await listExamples(call);
      case "scaffold_view": return await scaffold(call, "scaffold_view");
      case "scaffold_example": return await scaffold(call, "scaffold_example");
      case "collect": return await collect(call);
      case "collection_status": return await collectionStatus(call);
      case "cancel_collection": return await cancelCollection(call);
      case "view_result": return await viewResult(call);
      case "explain_failure": return await explainFailure(call);
    }
  } catch (cause) {
    const failed = err("INTERNAL", `${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return failure(format, "INTERNAL", failed.ok ? "" : failed.error.message);
  }
}

export { existsSync, readFile, canonicalJson, sha256Hex };
