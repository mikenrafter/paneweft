# Contract additions: ops slice (MC3 bounded output, MC4 completeness, MC5 provenance, MC14 embeds, MC19 paging)

Tests: `src/core/operations.{budget,completeness,provenance,paging,discovery,components,navigation}.test.ts`, helpers
`test/helpers/ops-*.ts`. Each entry: the question, the default the red tests pin, and why. All are proposals; overturn
by editing the cited test. "RC3" = `docs/red-contract.md` section 3, "D4" = `docs/design.md` section 4.

## 1. Outcome and body conventions
1. **Error bodies are always the JSON `paneweft.error/1` document**, whatever `format` was requested (the stub already
   does this; CLI "stdout = the reply body also for errors"). `outcome.format` still echoes the requested/default format.
2. **`outcome.payload` is the parsed JSON-form reply for BOTH formats** (text replies also carry the structure), and
   `outcome.cursor` equals the body's `cursor` (JSON key `cursor`, text last line `cursor: <token>`).
3. **`cursor` key is always present in JSON bodies** (null when no more), including `list_components`,
   `describe_component`, `search`, `open_entity`, `navigate` (NO_TARGET included).
4. **JSON items are the stored items** (list row, tree node, graph edge, shape field, notebook block, example run) with
   nothing added except `clipped: true` + `originalBytes` (item clipped) and `context: true` (tree ancestor). Items that
   need no flag carry no flag key (a test asserts an unclipped item has no `clipped` key). Source "items" are lines
   `{id:"L<n>", line, text}` (only counts and text lines are pinned for source).
5. **`originalBytes`** = UTF-8 length of the original value of the clipped string (60000 in the test), not of the item.
   The clipped JSON string is a plain prefix of the original (no ellipsis inside the value). Text form appends
   `[clipped: <originalBytes> bytes]` (pinned: matches `/clipped[^\n]*60000/`).

## 2. Counts along a cursor chain (RC3 invariants made precise)
RC3 says `returned + omitted = matched` and `cursor is null iff omitted = 0`, which cannot both hold on page 2 if `omitted`
means "everything not on this page". Proposal pinned by `assertChainCounts`: `total` and `matched` describe the whole query on
every page; `returned` = items on this page; `omitted` = matched items that FOLLOW this page; so
`offset + returned + omitted = matched` (offset = items on earlier pages) and `cursor == null iff omitted == 0`.
On the first page this is exactly RC3. Tree context items are in `items` but not in `returned`.
Question: is "following" the right reading, or should page 2 report `omitted` including earlier pages?

## 3. Gaps (partial views) are paged too
D4: "A short reply includes gap counts and at least the first named gap, with a cursor for the rest."
* Header always names gap #1 (`completeness: partial (<N> gaps; first: <id>: <question>)`; literal `1 gaps` for one gap as RC3
  writes it; the wording is awkward but pinned).
* The cursor stream is: matched items, then gaps #2..#N. JSON `completeness` carries `gapCount` (always N) and `gaps`
  (the gaps listed on THIS page; page 1 always starts with gap #1, so the chain concatenates to all N once each). Text:
  gap #1 only in the header line, `gap: <id>: <question>` body lines for gaps #2..#N (paged).
* Therefore the cursor is non-null while gaps remain even when `omitted = 0` (the `iff` of section 2 concerns items;
  tests that check it use views without gaps).
* The three notices (RC3): complete+total 0 -> `0 items within this scope`; partial+total 0 -> `no items returned;
  completeness is partial (see gaps)`; `matched = 0 < total` -> `no items match the current filters (0 of <total>)`;
  unsupported -> `this view is unsupported: <reason>`, counts all zero with the component's unit.

## 4. Text and JSON item grammar (what RC3 does not fix)
All are body lines after `<returned>/<matched> matched <unit> returned; <omitted> omitted` (+ optional notice line).
* **list** row (RC3): `<first cell> -> <kind>:<entity id>; <provenance>; <evidence ids>`, `-> (no entity)` without entity;
  an inferred row's line also contains its `reason`.
* **tree** (preorder over `roots`): `<2 spaces per depth><first cell> [<state>; children=<n>]`, state `expanded` (complete,
  has children), `leaf` (complete, none), `not_loaded` (printed `children=?`; never `leaf`); tree ancestors kept by a filter
  add ` [context]`.
* **graph** edges sorted by id: line contains `<from>`, `<relation>`, `<to>` in that order, then provenance/evidence
  (+ reason). `focus` acts as a filter: `total` = all submitted edges, `matched` = edges TRAVERSED by the BFS (RC6).
  Unit `edges`.
* **source** lines: `<file line number><non-word separator><text>` (numbering = anchor first line + index), unit `lines`,
  annotations as extra body lines containing id, line range, message and claim ids; when lines are omitted the body states
  `omitted lines <first omitted file line>-<last file line>`.
* **shape**: body line `basis: <declared|observed>`, then per field a line containing path, type, presence, provenance,
  evidence, `ref=<id>` when set, and exactly one of `no example` (key absent), `example: null`, `example: <JSON value>`.
* **notebook** blocks in authored order: line contains block id; claims also status word and statement; view blocks the
  view id; prose its markdown; example blocks the example id. Unit `blocks`; a `status` filter keeps only claims with
  that status (prose/view/example never match it).
* **example**: `not run` when `runs` is empty (and never when runs exist); per run a line with runId, status,
  `assertions=<passed>/<total>`, `result=<kind>:<id>` when present, the names of FAILED assertions only, the error text;
  always `rerun: paneweft example run <runnerId>` (D5).
* **Header provenance** counts every Item in the view's data (list rows; tree nodes; graph nodes AND edges; shape
  fields; notebook blocks; source excerpt + annotations; example scenario + runs + assertions). Tests pin list, shape and
  graph (read=4 for 3 nodes + 1 edge). Question: should graph count only edges (the unit)? Default: all fact items (D4 "10,000
  fact items per view").
* **Order tie-break:** `then item id in code-unit order` is read as id ASCENDING for both directions.
* **Header `order:`** for components without an `order` member is unpinned (JSON `order` null is allowed).
* **embedDepth 1:** an embedded view contributes its first header line `paneweft.reply/1 view=<id> component=<c>`; an
  embedded notebook contributes its block lines; embeds inside it, and an embed of the view itself, stay references.

## 5. Search (not specified by RC)
Unit `results`; JSON items carry `type` (`entity|view|example|claim`) and `id` (entity id; view id; example = the example
VIEW's id, indexed by its scenario label; claim = block id, plus `viewId`). Indexed texts: entity label; view title and
question; example scenario label; claim statement. Ranking per match: best tier over the texts (exact > prefix >
substring, case-insensitive), then type order entity < view < example < claim, then id in code-unit order. The oracle
`rankSearch` is proved in `test/helpers/ops-oracle.test.ts`. `search` JSON bodies have no `view`/`completeness` members,
so they are NOT validated against `reply.schema.json`; neither are `list_components` or `describe_component`.

## 6. Discovery, open_entity, navigate
* **list_components**: JSON `{items:[{id,question,capabilities}], counts(unit components), filters:{capability?}, notice?, cursor}`;
  the `capability` argument SCOPES the list (total = matched = components with it). Unknown capability: zero items,
  total 0 and a notice naming it. `open-entity` selects SIX components (not `example`: D2.7 lists select-run /
  filter-assertions / rerun / inspect-result), contrary to the brief's "all seven?". Only `focus-neighborhood` -> graph and
  `open-entity` are pinned.
* **describe_component** JSON page: `{component, section, chunk, chunkIndex, chunkCount, cursor}`; `section` is any string;
  the concatenated `chunk`s parse to `{id, question, capabilities, limits, schema, example}`; `limits` must mention 200
  and 500 for graph (D4). Text pages are only bounded/well-formed.
* **open_entity** JSON: the initial view's reply (RC3) plus `pane`, `views:{available,needs_data,unsupported}` (entries
  `{viewDefinitionId,title,component,priority}` + `missing:[roles]` / `reason`) and `selected:{viewDefinitionId,
  fallbackFrom?:{requested,reason}}`. Text: the reply, then lines `available: <def> <title> (<component>)`, `needs_data:
  <def> <title> missing: <r1>, <r2>`, `unsupported: <def> <title> (<reason>)`. An entity with no registered view opens a
  built-in pane (reply shape beyond `pane/views/selected` unpinned; not schema-validated).
* **navigate**: same body as `open_entity` for the target; item without entity -> OK result
  `{pane:null, notice:{code:"NO_TARGET", itemId, message}, cursor:null}` (message names the item). Unknown item,
  unregistered target entity, or a target registered only in another snapshot -> `UNRESOLVED_TARGET` whose message
  names the item/entity (and the snapshot). The target opens in the PANE's snapshot. `pane` argument faults:
  missing member `/pane/entity` -> INVALID_ARGUMENT REQUIRED.
* **inspect_view** with an unknown view or snapshot -> `UNRESOLVED_TARGET` naming it (not `NOT_FOUND`).
* **Cursor faults**: CURSOR_INVALID / CURSOR_MISMATCH / CURSOR_STALE carry exactly one issue with pointer `/cursor`. CURSOR_STALE (review S10): the cursor belongs to this query but the listing's entries changed since it was issued (a notebook edit, a recorded run, an import that changes a search); repeat the request without a cursor. Order of checks: INVALID, MISMATCH, STALE, then the position. Non-object tool arguments:
  INVALID_ARGUMENT with one issue `("", TYPE)`.

* **Confined reads are Linux-only in v0** (review round 2, S1). Reading a source anchor, hashing a file for freshness and serving a viewer asset all go through `readConfinedFile`, which vouches for a read with `/proc/self/fd`. Without it nothing is opened and the read fails closed with the reason `unsupported-platform`; there is no weaker fallback (a device/inode comparison against a re-resolved pathname leaves the check-to-use window open). Visible effects: an anchor read is `UNSUPPORTED_PLATFORM` (HTTP 501, not retryable); a repository whose recorded files cannot be read is `unverified` in freshness with `code: "UNSUPPORTED_PLATFORM"`; a source link's currency is `unknown`; the viewer serves only the regular files that were direct children of its assets directory at start-up (held in memory) and answers 404 for any other asset path.
* **Confined reads are capped at 16 MiB** (tier-2 review, T4). The handle is fstat'ed before anything is read; a file over 16777216 bytes is never read, and the read itself is counted so a file that grows afterwards is refused too. Hashing streams in 64 KiB chunks. Visible effects: an anchor read of such a file is `FILE_TOO_LARGE`; a recorded file that big is not hashed, so the repository's freshness is `unknown` (an `unverified` entry with `code: "FILE_TOO_LARGE"` and `paths` names it; a file that really changed still makes the view `stale`); a source link's currency is `unknown`; the viewer answers 404 for such an asset. A file of exactly 16777216 bytes is read and hashed.

## 7. Open questions
1. **Progress at the minimum budget.** `minimumBytes` = smallest budget that fits the mandatory header. At exactly that budget a
   reply may carry zero items and the same position as cursor, so a chain would not advance. Proposal: minimumBytes should
   also leave room for one (clipped) item. Not tested (the chain tests use budgets with ample room).
2. **Clip placement.** With other rows beside it, an oversize item may be clipped on the current page or deferred to the next;
   only the single-row case is pinned.
3. **Counts on later pages** (section 2) and **graph `total` under focus** (section 4) are the least obvious defaults.
