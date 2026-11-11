# Red-phase contract

`docs/design.md` is the product contract. This file is the **normative interpretation** the red tests
pin where the design leaves a decision open. Every choice here is a proposal the owner can overturn; the
ambiguities are listed in the red report with the reason for each default. A test that asserts something
not in the design cites the section below in its WHY.

Conventions: `CLAIM(MCn)` ids are the design's section 7 claims. "Reply" means the `body` string an
operation returns. All byte counts are UTF-8.

## 1. Layers and public boundaries

| Layer | Module | Boundary tests use |
|---|---|---|
| Schemas | `src/schemas/*.json` | Raw Ajv (scaffold self-check) and `describe_component` |
| Validation | `src/core/validate.ts` | `validateSubmission`, `validateRunOutput` |
| Operations | `src/core/operations.ts` | `executeOperation(session, toolName, args)` - the 13 tools |
| Storage | `src/core/session.ts` | `openSession(dir)` and the `Session` interface |
| Navigation | `src/core/inspector.ts`, `registry.ts`, `links.ts` | pure reducer / `rankViews` / `resolveLink` |
| Anchors, freshness | `src/core/anchors.ts`, `freshness.ts` | `resolveSourceAnchor`, `checkFreshness` |
| Layout | `src/core/layout.ts` | `computeGraphLayout`, `graphNeighborhood` |
| Examples | `src/core/runner.ts` | `runExample`, `Session.recordExampleRun` |
| Markdown | `src/core/markdown.ts` | `renderMarkdown`, `jsonForScriptElement`, `isSafeLinkUrl` |
| Viewer DOM | `src/viewer/mount.ts` | `mountViewer(container, {source, viewport, locale})` |
| Viewer HTTP | `src/viewer/server.ts` | `startViewer({session})` |
| CLI | `src/cli/main.ts`, `src/cli/bin.ts` | `runCli` in-process, `bin.ts` as a process |
| MCP | `src/mcp/server.ts` | `paneweft mcp --session DIR` over stdio |

Stubs return `NOT_IMPLEMENTED` values (`notImplemented()`), so tests fail on assertions. Green deletes
every use of `NOT_IMPLEMENTED`.

## 2. Error model

Operation error body (`src/schemas/error.schema.json`):
`{schemaVersion:"paneweft.error/1", code, message, errors:[{code, pointer, constraint, hint}], retryable, details?}`.

* `code` is one of `OPERATION_ERROR_CODES`; each entry in `errors` has a fine-grained `ISSUE_CODES` code
  (design 4 gives entries `{pointer, constraint, hint}`; the per-entry `code` is added because the
  design's `validate` row says "errors with code, JSON pointer, expected constraint, and repair hint").
* Any invalid submission is `VALIDATION_FAILED` with the issues in `errors`.
* Issues are sorted by `(pointer, code)` and are deterministic.
* A single fault yields a single issue (no echo from other schema branches).

Ajv keyword to issue code, and where the pointer lands:

| Fault | code | pointer |
|---|---|---|
| missing required property | `REQUIRED` | the missing property's path (`/data/focus/depth` for a missing `depth`) |
| wrong JSON type | `TYPE` | the value |
| `enum` / non-version `const` | `ENUM` | the value |
| `schemaVersion` not the pinned literal | `SCHEMA_VERSION` | `/schemaVersion` |
| `component` outside the seven | `UNKNOWN_COMPONENT` | `/component` (data is then not checked) |
| unknown property (`additionalProperties`/`unevaluatedProperties`) | `UNKNOWN_PROPERTY` | the unknown property's path |
| property forbidden by a variant (`false` schema) | `FORBIDDEN_PROPERTY` | the property's path |
| `pattern` / `format` | `PATTERN` | the value |
| `minimum` / `maximum` | `OUT_OF_RANGE` | the value |
| length / item-count bounds | `SIZE` | the value |

`constraint` states the rule ("type: integer"); `hint` is the schema's `x-hint` when present, else a
sentence built from the keyword that names the property or expected type. Hints are never empty.

Semantic issue codes and pointers (design 5 "referential integrity, unique IDs, valid line ranges,
contiguous paths, variant rules, and cycle constraints"):

| code | meaning | pointer |
|---|---|---|
| `DUPLICATE_ID` | an item id repeats within one view (ids are one namespace across all of a view's arrays); a run id repeats | the later occurrence's `id` |
| `DANGLING_REFERENCE` | unknown source id in `evidence`/`basis`; edge endpoint; tree root/child; path edge id; unknown column in `cells` or `order.key`; shape child/`ref`; `focus.node`; notebook `supports`/`contradicts`/`viewId` (bundle only); bundle entity/definition | the referring value |
| `INVALID_LINE_RANGE` | first > last | the `lines` array |
| `ANNOTATION_OUTSIDE_EXCERPT` | annotation lines not inside the excerpt anchor's lines | the annotation's `lines` |
| `TREE_CYCLE` | a node is its own descendant | the `children/N` value that closes the cycle |
| `ALIAS_CYCLE` | `forward` chain returns to a definition (self-forward included) | `/definitions/N/forward` |
| `PATH_DISCONTINUOUS` | path edge N+1 does not start where edge N ends | the offending `edgeIds/N` |
| `PROVENANCE_RUN_REQUIRED` | `observed` item whose evidence sources have no `runId` | the item's `provenance` |
| `PASSED_WITH_FAILED_ASSERTION` | `status: passed` with a failing assertion | the run's `status` |
| `LIMIT_EXCEEDED` | a v0 limit (design 4) | the offending value; `""` for whole-document size |

Reference scope: a single envelope is checked intra-document only (references to other views are
deferred to `render`/import). A bundle also checks every cross-member reference against bundle plus
`ReferenceContext`. Item `entity` references are soft (resolved at navigation time).

Other operation codes: `BUDGET_TOO_SMALL` (details `{minimumBytes}`), `INVALID_ARGUMENT` (pointer into
the tool arguments), `CURSOR_INVALID` (malformed/tampered), `CURSOR_MISMATCH` (query/snapshot/order
changed), `CONFLICT` (details `{currentRevision}`; retryable after re-read), `SNAPSHOT_CONFLICT`,
`UNRESOLVED_TARGET`, `SESSION_REQUIRED`, path/runner/storage codes as named in `errors.ts`.

## 3. Bounded replies

Request arguments (every reply-producing tool): `format` (`text`|`json`, default `text`), `maxBytes`
(default 8192, 2048..32768), `cursor`. `maxBytes < 2048` is `BUDGET_TOO_SMALL` with
`details.minimumBytes = 2048`; `> 32768` is `INVALID_ARGUMENT` at `/maxBytes`. When the mandatory header
alone does not fit, `BUDGET_TOO_SMALL` with `details.minimumBytes` = the smallest budget that fits it.
The error body itself is within the requested budget.

**Invariant:** `Buffer.byteLength(body) <= maxBytes`; JSON bodies parse; text bodies contain no U+FFFD;
nothing slices a code point. Over MCP the budget covers all content blocks plus any
`structuredContent` (the server returns exactly one text block and no `structuredContent`).

Mandatory header (never dropped, even with zero matches). Text form, one line each, in this order:

```
paneweft.reply/1 view=<viewId> component=<component>
question: <question>
snapshot: <snapshotId>
completeness: complete (<criterion>)
completeness: partial (<gapCount> gaps; first: <gapId>: <gap question>)
completeness: unsupported (<reason>; missing: <cap>, <cap>)
freshness: fresh | stale (changed: <path>, <path>) | unknown (inaccessible: <root>, <root>)
provenance: read=N parsed=N compiled=N observed=N inferred=N
evidence: sources=<id>,<id>
filters: none | text="<t>" columns.<key>=<v> provenance=<a>,<b> relation=<r> status=<s>
order: <key> <asc|desc>
counts: unit=<unit> total=T matched=M returned=R omitted=O truncated=<true|false>
```

(exactly one `completeness:` line, in the variant of the view's status). Then the body, then
`cursor: <token>` when more content exists. `provenance` and `evidence` count the **whole view**
(unfiltered); `counts` refer to the filtered collection. JSON form: `src/schemas/reply.schema.json`
with the same fields. Counts invariants: `returned + omitted = matched`; `matched <= total`;
`truncated = omitted > 0 || clipped items`; `cursor` is `null` iff `omitted = 0`.

Body, first line: `<returned>/<matched> matched <unit> returned; <omitted> omitted`. List item line
(design 4 example): `<first cell> -> <entity kind>:<entity id>; <provenance>; <evidence ids>` e.g.
`mcp.rs -> code/module:mcp; read; s1`; an item with no entity prints `-> (no entity)`.
Units: list `rows`, tree `nodes`, graph `edges`, source `lines`, shape `fields`, notebook `blocks`,
example `runs`.

`notice` (JSON; also a text body line): complete and `total = 0` -> `0 items within this scope`;
partial and `total = 0` -> `no items returned; completeness is partial (see gaps)` (never the former);
`matched = 0 < total` -> `no items match the current filters (0 of <total>)`; unsupported ->
`this view is unsupported: <reason>`.

Cursor: opaque, binds `(viewId, snapshotId, filter, order, position)`. Another filter/order/snapshot ->
`CURSOR_MISMATCH`; garbage -> `CURSOR_INVALID`. Ordering is the view's `order` (or the request's), then
item id by code-unit order. One item larger than the budget is clipped at a code-point boundary and
marked `clipped: true` (JSON) with `originalBytes`.

Filter members (AND): `text` (case-insensitive substring of label or any string cell), `columns`
(exact cell equality), `provenance` (any of), `relation` (graph edges), `status` (notebook claims).
Tree filtering keeps matching nodes plus their ancestors; ancestors are returned flagged
`context: true` and are not counted in `matched`.

`embedDepth` (notebook, 0 or 1): 1 inlines each embedded view's header line and each embedded
notebook's block lines; embeds inside an embedded notebook stay references with a link; embed cycles are
cut. `embedDepth > 1` is `INVALID_ARGUMENT`.

`describe_component` replies page `{component, section, chunk, chunkIndex, chunkCount}`; the
concatenated chunks parse to `{id, question, capabilities, limits, schema, example}` where `schema` is
the canonical schema document and `example` validates.

## 4. Inspector reducer

State `{trail, retained, past}`; panes `{entity, snapshotId, viewDefinitionId, selection, filters, pinned}`.
* Every action that changes `{trail, retained}` (by deep equality) pushes the previous
  `{trail, retained}` onto `past`.
* `open{entity,snapshotId,viewDefinitionId?}`: trail becomes `[new pane]`; pinned trail panes move to
  `retained` (trail order appended), unpinned ones are dropped. View = preferred if `world.hasView`, else
  `world.initialView`; none -> notice `UNKNOWN_VIEW`, state unchanged.
* `select{paneIndex,itemId}`: out of range -> notice `NO_SUCH_PANE`; `itemTarget` missing -> notice
  `UNRESOLVED_TARGET`, state unchanged. Otherwise pane selection becomes `[itemId]`, the trail is cut to
  `paneIndex+1`, pinned cut panes move to `retained`, unpinned are dropped; target `entity` -> a new pane
  (same snapshot, `world.initialView`); target `none` -> no pane, notice `NO_TARGET` (state still changed).
* `switchView{paneIndex,viewDefinitionId}`: unknown view -> `UNKNOWN_VIEW`; else pane view changes,
  selection keeps only ids that `itemExists` in the new view; other panes untouched.
* `pin{paneIndex}`: sets `pinned = true` on a trail pane (already pinned: unchanged state).
* `back`: restore the last `past` frame (empty -> notice `NOTHING_TO_GO_BACK`).
* Tree expansion is not an action: it never creates a pane.

## 5. Registry and applicability

`rankViews`: exact kind match; `*` built-ins `builtin:metadata` (priority 1000) and `builtin:raw` (1001)
always appended and always available; default priority 50; order = priority then id by code-unit order;
required roles = `requires` union `{dataRole}`; missing = required minus `entity.dataRoles` (sorted) ->
`needs_data`; an instance with `completeness.status = unsupported` -> `unsupported` with its reason.
`selected`: available preferred wins; unavailable or unknown preferred -> first available with
`fallbackFrom{requested, reason}`; no preference -> first available. `Session.registerView` increments an
integer revision by 1; a stale `expectedRevision` is `CONFLICT` with `details.currentRevision`; the
registry persists across `openSession`. A definition's `component` must be one of the seven.

## 6. Layout v1 (`LAYOUT_VERSION = "layout/1"`)

Constants `nodeWidth 160, nodeHeight 40, gapX 80, gapY 24, margin 16`. All numbers are integers.
**Layered:** strongly connected components -> condensation DAG; `layer(g) = 0` without incoming groups,
else `1 + max(layer(pred))`. Within a layer, groups ordered by smallest member id, members by id
(code-unit order); `row` counts nodes down the layer from 0. `x = margin + layer*(160+80)`,
`y = margin + row*(40+24)`. `width = 2*margin + (maxLayer+1)*160 + maxLayer*80`,
`height = 2*margin + maxRows*40 + (maxRows-1)*24`; an empty graph is 32x32.
**Grid:** nodes by id; `cols = ceil(sqrt(n))`; node i at `col = i % cols`, `row = floor(i/cols)`, `layer := col`.
**Edge path `d`** (`M`/`L` with single spaces): layered forward edge (`layer(from) < layer(to)`):
`M {fx+160} {fy+20} L {tx} {ty+20}`. Otherwise (same layer, back edge, SCC member): bottom route
`M {fx+80} {fy+40} L {fx+80} {yb} L {tx+80} {yb} L {tx+80} {ty+40}` with `yb = max(fy,ty)+40+12`.
Self loop: `M {fx+160} {fy+20} L {fx+200} {fy+20} L {fx+200} {fy+52} L {fx+80} {fy+52} L {fx+80} {fy+40}`.
Grid edges: `M {cx} {cy} L {cx'} {cy'}` between node centres. Output nodes and edges are sorted by id and
independent of input order. `graphNeighborhood`: BFS from `focus.node` up to `depth` steps along allowed
direction(s); returns the visited node ids and the edge ids **traversed** (sorted).

## 7. Markdown

`renderMarkdown(md)` -> HTML string using only `p br strong em code pre ul ol li blockquote h1-h6 hr a`.
`a` has only `href` (http:, https:, mailto: or `#fragment`) and `rel="noopener noreferrer"`. Raw HTML in
the input appears as escaped text. Images never become `<img>`. Any other URL scheme (javascript:, data:,
file:, vbscript:, ...) renders the link text without a link. `jsonForScriptElement(v)` yields JSON text
safe inside `<script type="application/json">`: no raw `<`, `>`, `&`, U+2028, U+2029; `JSON.parse` of it
equals `v`.

## 8. Viewer HTTP (loopback, session credential)

`startViewer` binds `127.0.0.1` (default) or `::1`; any other host -> `NON_LOOPBACK_HOST`. Token: >= 128
bits, base64url or hex, unique per instance. `server.json` `{origin, token, pid}` is written (mode 0600)
into the session directory while serving and removed on `close`; `render` replies carry
`viewerUrl: string | null` (`${origin}/#token=${token}&view=..&snapshot=..`; `null` without `server.json`).
* `GET /` and `GET /assets/<file>`: no token; `Host` must be the server's own loopback `host:port`
  (else 403 `FORBIDDEN_ORIGIN`); nothing outside `assetsDirectory` is ever served (`..`, encoded `..`,
  absolute paths, NUL: 400/403/404).
* `/api/*`: `Authorization: Bearer <token>` (missing/wrong -> 401 `UNAUTHORIZED`). No CORS headers.
* Reads: `GET /api/index`, `/api/entity?snapshot=&repository=&id=&kind=`,
  `/api/view?viewId=&snapshotId=`, `/api/source?viewId=&snapshotId=&itemId=` (never a path),
  `/api/search?q=`, `/api/registry`.
* Writes: `POST /api/notebooks/<pageId>/revisions` body `{expectedRevision, blocks}`; `Origin` must be
  absent or equal to the server origin (else 403 `FORBIDDEN_ORIGIN`). There is no route that executes
  anything.
* Unknown routes: 404 `paneweft.error/1`. Only manifest-registered, validated snapshots are served.

## 9. CLI

`paneweft [--session DIR] <command> ...` (`PANEWEFT_SESSION` is the fallback). Commands: `components`,
`describe`, `validate`, `render`, `open`, `navigate`, `inspect`, `search`, `notebook create|get|update`,
`example record|run`, `serve`, `mcp`. Every operation command accepts the tool's arguments verbatim as
`--args '<json>'`, `--args-file FILE` or `--args-file -`; flags (`--file`, `--format`, `--max-bytes`,
`--cursor`, `--component`...) are sugar for the same arguments. stdout = the reply body (also for
operation errors); exit 0 ok, 1 operation error, 2 usage error (stderr). CLI and MCP bodies for the same
request are byte-identical (except `viewerUrl` when a server runs).

## 10. Runners (`runner.ts`)

Registry file `{ "runners": [RunnerDefinition] }`, owner-written, never written by any API. The run id
is generated by paneweft and given to the runner as `PANEWEFT_RUN_ID`; `run.runId` in the output must
equal it. Missing runner `RUNNER_NOT_FOUND`; timeout `RUNNER_TIMEOUT` (process killed); non-JSON or
schema-invalid or missing output `RUNNER_OUTPUT_INVALID` (details list pointers); a stale output file is
deleted before the run. Parameters substitute `{param:name}` inside argv elements; no shell.
`recordExampleRun` stores a run append-only; the same `runId` again is `DUPLICATE_RUN`; its
`output.bundle` entities/definitions are registered with the same atomicity as `importBundle`; the run's
`result` must resolve to an entity in the bundle or the session.

## 11. Fixtures

Component fixtures use repository `r`, snapshot `snap-1`; the bundle's views equal the component
fixtures. Demo fixtures use real repositories and the hashes in design 6. Every fixture that is meant
to be valid must pass `validateSubmission` with `ok: true` and is checked by raw Ajv in
`test/scaffold`.
