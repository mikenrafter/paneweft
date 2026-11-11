# Demo fixtures (design section 6)

Three committed `paneweft.bundle/1` documents for the worked demos on owner code:

| File | Repository | Views | Entities | Definitions |
|---|---|---|---|---|
| `vigil.bundle.json` | `vigil` (Rust), snapshot `vigil-d064373` | `vigil-lifecycle` (graph), `vigil-delivery-path` (graph), `vigil-one-write` (example), `vigil-cancel-guard` (source) | `vigil/watch:watch`, `vigil/delivery:keepalive-delivery`, `vigil/watch:one-write` | 4 |
| `residual.bundle.json` | `residual-web` (TypeScript), snapshot `residual-32c0836` | `residual-view-entrypoints` (list), `residual-selection-shape` (shape), `residual-selection-switch` (example), `residual-key-union` (source) | `residual/landscape`, `residual/selection` x2, `code/module` x3 | 4 |
| `story.bundle.json` | `paneweft` + both above, snapshot `story-1` | `story-context-change` (notebook, "What survives a change of context?") | `notes/page:context-story` | 1 |

Design section 6 names six views. The two `source` views (`vigil-cancel-guard`, `residual-key-union`) are added because
the design's own navigation story ("page -> vigil delivery -> cancellation source -> example result", "page -> residual
selection shape -> key variant -> example result") needs a cancellation source and a key variant to land on. The page
also carries two `example` blocks (`ex1`, `ex2`) that the design's prose describes but its JSON omits; see
`docs/contract-additions/demo.md` (A1, A9).

## What these are, and what they are not

* Everything is **source-inspected**: every item has provenance `read` and every source is a file (or the design
  note) whose bytes were read and hashed. **Nothing was built, executed, run or observed.** Read test assertions say what a
  test checks, not that it passes in this checkout.
* The two example views (`vigil-one-write`, `residual-selection-switch`) have `runs: []`: **NOT RUN**. Their completeness is
  `partial` and names the missing observed run (`observed-run-missing`) and the missing scenario adapter (`adapter-missing`).
  Because no run exists, no result entity exists either: the scenario entities are registered (kinds `vigil/watch` and
  `residual/selection`), `vigil/watch-result` and `residual/selection-result` are not.
* The story bundle references the six view ids of the other two bundles, so it **fails standalone validation by design**
  (`DANGLING_REFERENCE` at `/views/0/data/blocks/{1,2,3,5,6,7}/viewId`) and must be imported after them.
* Revisions: vigil `d064373a15139b969599ee05bc7b156b1d5b8ed7` (the enclosing phoe-nix checkout has unrelated dirty files in other
  scout modules; `git status --short scout-modules/vigil` is empty, so `dirty: false`), residual-cli
  `32c0836283dad8c22431b3025ec910b4b5759e90` (clean). The design note is recorded at
  `2765c525907bda1a95bcc5ecf03a1bf4a93bc7a7` (last commit that touched `docs/design.md`).

## Hashes

`freshness.files` of each view holds exactly the files that view cites, with the design 6 hashes (design.md lines 518-522 and
538-540; the literal copy lives in `test/scaffold/demos.scaffold.test.ts`):

| File | SHA-256 |
|---|---|
| `src/watch.rs` | `62f0229b71d3984a5187787780f9a2b26bfc592277281c8ed02b66802e451742` |
| `src/engine.rs` | `79cf0ad0ec83d68638a8ce414bde91375b3e11b93d40e79b00dc1086079e65ca` |
| `src/tick.rs` | `4355040b691eabbf6cbb367f69c1e583701dc5b8b41a421ffba7782fd48f6857` |
| `src/mcp.rs` | `1f627598551a007472cacecb61f4a649b8f60bb089ed16f67ce6f1145d415c25` |
| `tests/mcp_e2e.rs` | `1d0cd2cd40f8e156b3f0b9333c6d6c403b52400be5b17fd288a5d276b0c67e1f` |
| `web/src/nkp-landscape.ts` | `6eeb5997136297df81c28a9dfec1a4005a8d5560d61e5d0b914015d44523a9df` |
| `web/src/landscape-selection.ts` | `38418e62f565f9f32020068263e5344cb9759a39c17523d6832198f5933e0795` |
| `web/src/nkp-landscape.test.ts` | `d1f9db2be5dffa209793da697ea7c971f4ed07d90a1ab9a15c3ce57f0d5ecd8b` |
| `docs/design.md` (paneweft, source `sd`) | `d130a8070810e4e9e9b0881c45490aa8ea6d1ad63136d07c7230b170f3aadd3d` |

The `sd` hash is the SHA-256 of `docs/design.md` **at fixture-writing time (2026-11-11)**. If the design note is edited, recompute
`sha256sum docs/design.md` and replace it in `story.bundle.json` (`sources[sd].sha256` and `freshness.repositories[paneweft].files`)
and in this file; `test/scaffold/demos.scaffold.test.ts` fails until you do ("sd source ... bytes in this checkout").

## Verification commands

```sh
# 1. Hashes of the inspected bytes (compare with the table above)
cd /home/mini/Documents/repos/phoe-nix/scout-modules/vigil && sha256sum src/watch.rs src/engine.rs src/tick.rs src/mcp.rs tests/mcp_e2e.rs
cd /home/mini/Documents/repos/residual-cli && sha256sum web/src/nkp-landscape.ts web/src/landscape-selection.ts web/src/nkp-landscape.test.ts
sha256sum /home/mini/Documents/repos/paneweft/docs/design.md

# 2. Revisions and cleanliness
git -C /home/mini/Documents/repos/phoe-nix rev-parse HEAD            # d064373a15139b969599ee05bc7b156b1d5b8ed7
git -C /home/mini/Documents/repos/phoe-nix status --short scout-modules/vigil   # empty
git -C /home/mini/Documents/repos/residual-cli rev-parse HEAD        # 32c0836283dad8c22431b3025ec910b4b5759e90
git -C /home/mini/Documents/repos/residual-cli status --short        # empty

# 3. The two verbatim excerpts equal the source lines they claim
node -e 'const fs=require("fs");const R="/home/mini/Documents/repos/";
const cut=(p,a,z)=>fs.readFileSync(R+p,"utf8").split("\n").slice(a-1,z).join("\n");
const v=JSON.parse(fs.readFileSync("fixtures/demos/vigil.bundle.json")).views[3].data.excerpt;
const r=JSON.parse(fs.readFileSync("fixtures/demos/residual.bundle.json")).views[3].data.excerpt;
console.log(cut("phoe-nix/scout-modules/vigil/src/mcp.rs",155,185)===v.text, cut("residual-cli/web/src/landscape-selection.ts",1,15)===r.text)'

# 4. Print the first and last line of every anchor (eyeball against the table below)
sed -n '413,418p' /home/mini/Documents/repos/phoe-nix/scout-modules/vigil/src/watch.rs
sed -n '277,304p' /home/mini/Documents/repos/phoe-nix/scout-modules/vigil/src/engine.rs
sed -n '132,141p;175,187p;193,201p' /home/mini/Documents/repos/phoe-nix/scout-modules/vigil/src/tick.rs
sed -n '122,190p' /home/mini/Documents/repos/phoe-nix/scout-modules/vigil/src/mcp.rs
sed -n '111,156p' /home/mini/Documents/repos/phoe-nix/scout-modules/vigil/tests/mcp_e2e.rs
sed -n '14,24p;43,45p;158,177p;245,255p' /home/mini/Documents/repos/residual-cli/web/src/nkp-landscape.ts
sed -n '1,23p;44,45p;345,351p' /home/mini/Documents/repos/residual-cli/web/src/landscape-selection.ts
sed -n '270,277p;336,364p' /home/mini/Documents/repos/residual-cli/web/src/nkp-landscape.test.ts

# 5. Schema and semantic validity, and the red tests (run on the Boat sandbox, not on the host)
npx vitest run test/scaffold/demos.scaffold.test.ts   # raw Ajv + independent checker, green by design
npx vitest run test/demos.test.ts                     # red against the stubs
```

## Where the design and the code differ

Recorded while reading (details at the lines in the tables below):

1. **Imports vs ownership.** Design 6 says `mountLandscape` "imports their builders". The imports are module-level
   (`web/src/nkp-landscape.ts:14-20`); `mountLandscape` (`:167`) *calls* the factories inside `ensureViewHandle` (`:245-255`) and owns
   `viewHandle`/`activeView` (`:174-175`) and the selection `Set` (`:176`). The list view records the call sites.
2. **Range `:14` to `:44`.** The declarations are at `:22-24`; `parseLandscapeView` is `:43-45` (line 45 is its closing brace). The
   completeness criterion of `residual-view-entrypoints` cites `:22-24`.
3. **D2 is weaker than its wording.** `web/src/nkp-landscape.test.ts:336` and `:351` only assert that the sidebar text still
   *contains the substring* `auth`; the "filter change" is one flip of `data-hide-filtered-graph-toggle`
   (`:358-360`), not a changed matrix row set or fission threshold; the view switch visits heatmap then regions. No key identity or active
   key is asserted. `residual-selection-switch` records this in `scope.limits`.
4. **The existing tests are `bun:test`** (`web/src/nkp-landscape.test.ts:1`) over a DOM that comments mention as happy-dom
   (`:123`). A scenario adapter for `residual-selection-switch` must run under bun, unlike the vitest-based demo suites.
5. **`cancelled_result()` is an error result.** `src/mcp.rs:188-190` builds `text_result(true, "cancelled")`, i.e. `isError`. The
   delivery graph says so; the design only says the result "stops being delivered".
6. **Block `v3` cites `sv`.** In the design's JSON the `vigil-one-write` block's evidence is `sv` (the `src/mcp.rs` source) although
   that view is built from `tests/mcp_e2e.rs`. Kept as the design has it (the page registers only `sv`, `sr`, `sd`).
7. **No result entity yet.** "page -> ... -> example result" ends at the example *scenario*: both `runs` are empty.
8. **Extra cancellation test not used.** `tests/mcp_e2e.rs:357` (`a_cancelled_keepalive_stops_sensing_and_does_not_consume_a_finished_result`)
   exercises the same property as claim D1 with a real cancelled request; the design does not cite it, so no item uses it.

Everything else the design states about these lines matched the code: `WatchStatus` variants at `src/watch.rs:413-418`;
`cancel` (`src/engine.rs:280`) expiring an overdue pending watch before cancelling and returning an already finished result unchanged
(`:286-299`); the tick's deadline check before sensing (`src/tick.rs:132`) and budget check after sensing and judging (`:178`);
`run_keepalive` racing the work against progress forwarding, racing cancel against a bounded flush, polling cancel once more and only then
calling `commit_delivery` (`src/mcp.rs:127-185`); the one-write test's assertions (`tests/mcp_e2e.rs:112-156`); `EntityKey`
(`web/src/landscape-selection.ts:15`), `entityDetail` (`:45`) and `toggleSelection` (`:346`); `mountLandscape` (`web/src/nkp-landscape.ts:167`);
the test line numbers `:270`, `:336`, `:351`.

## Facts and where they were read

One row per item, generated from the committed JSON (the `read at` column is the item's `anchor`). Lines are one-based and inclusive.

### vigil-lifecycle (graph, snapshot vigil-d064373)

When does a watch stop, and what takes precedence?

Completeness: partial - gaps: firing-rules, attention-events, recovery. Sources: s-watch = src/watch.rs; s-engine = src/engine.rs; s-tick = src/tick.rs.

| item | kind | read at | fact |
|---|---|---|---|
| `n-pending` | node | `src/watch.rs:414` | pending: WatchStatus::Pending, the only unfinished status (is_finished is status != Pending, src/watch.rs:421-423) |
| `n-fired` | node | `src/watch.rs:415` | fired: WatchStatus::Fired (finished) |
| `n-expired` | node | `src/watch.rs:416` | expired: WatchStatus::Expired (finished) |
| `n-cancelled` | node | `src/watch.rs:417` | cancelled: WatchStatus::Cancelled (finished) |
| `e-tick-fires` | edge n-pending -> n-fired [tick fires] | `src/tick.rs:193-201` | tick: when the fire rule produced events the tick finishes the watch with TerminalStatus::Fired (src/tick.rs:193-201) |
| `e-tick-overdue-start` | edge n-pending -> n-expired [tick expires] | `src/tick.rs:132-141` | tick: a pending watch whose deadline has passed is expired before any sensing; R5: no final tick, no event (src/tick.rs:132-141) |
| `e-tick-over-budget` | edge n-pending -> n-pending [tick writes nothing] | `src/tick.rs:178-180` | tick: after sensing and judging, past the call budget nothing is written and the watch stays pending (C5, OutOfBudget, src/tick.rs:178-180) |
| `e-tick-overdue-after` | edge n-pending -> n-expired [tick expires] | `src/tick.rs:181-187` | tick: after sensing and judging, a watch now past its deadline expires instead of firing on a late result (C6, R5, src/tick.rs:181-187) |
| `e-cancel-expires` | edge n-pending -> n-expired [cancel expires] | `src/engine.rs:286-289` | cancel: a pending watch past its deadline is expired first (W5: expiry wins), never cancelled (src/engine.rs:286-289) |
| `e-cancel-cancels` | edge n-pending -> n-cancelled [cancel cancels] | `src/engine.rs:290-298` | cancel: a pending watch not past its deadline is finished with TerminalStatus::Cancelled (src/engine.rs:290-298) |
| `e-keep-fired` | edge n-fired -> n-fired [cancel keeps result] | `src/engine.rs:290` | cancel on a fired watch changes nothing: the stored result is returned (V4, doc src/engine.rs:277-279, guard :290) |
| `e-keep-expired` | edge n-expired -> n-expired [cancel keeps result] | `src/engine.rs:290` | cancel on an expired watch changes nothing: the stored result is returned (V4, doc src/engine.rs:277-279, guard :290) |
| `e-keep-cancelled` | edge n-cancelled -> n-cancelled [cancel keeps result] | `src/engine.rs:290` | cancel on a cancelled watch changes nothing: the stored result is returned (V4, doc src/engine.rs:277-279, guard :290) |
| `e-status-reads-expired` | edge n-pending -> n-expired [status reads expired] | `src/engine.rs:248-254` | status: an overdue pending watch is read as expired by expired_if_overdue (V16); status() contains no save (src/engine.rs:248-254) |

### vigil-delivery-path (graph, snapshot vigil-d064373)

Where can an MCP keepalive result stop being delivered?

Completeness: partial - gaps: delivery-bookkeeping, async-trace. Sources: s-mcp = src/mcp.rs.

| item | kind | read at | fact |
|---|---|---|---|
| `n-run` | node | `src/mcp.rs:122-136` | run_keepalive: runs the keepalive work, forwards progress, stops when cancel completes (src/mcp.rs:122-136) |
| `n-engine` | node | `src/mcp.rs:140-154` | vigil.keepalive_uncommitted(request, &sink, &mut cancel): the work, run inside tokio::select! against the forwarder (biased, src/mcp.rs:140-154) |
| `n-forward` | node | `src/mcp.rs:143-148` | progress forwarder: drains ChannelProgress updates into notify while the work runs; progress is best effort per the doc comment (C11, src/mcp.rs:122-126; forwarder :143-148) |
| `n-flush` | node | `src/mcp.rs:158-173` | bounded flush: queued progress is sent for at most min(PROGRESS_FLUSH = 250 ms, rest of the call's max_s) while cancel is polled first (src/mcp.rs:158-173) |
| `n-recheck` | node | `src/mcp.rs:175-180` | final cancel poll: cancelled = cancelled_in_flush \|\| a biased select that sees cancel before an immediate ready (src/mcp.rs:175-180) |
| `n-commit` | node | `src/mcp.rs:184` | vigil.commit_delivery(delivery): the only place the results count as returned (src/mcp.rs:184) |
| `n-return-some` | node | `src/mcp.rs:185` | Ok(Some(envelope)): the result is returned to the caller (src/mcp.rs:185) |
| `n-return-none` | node | `src/mcp.rs:181-183` | Ok(None): cancelled, nothing committed, the results stay for the next call (C2, src/mcp.rs:174, :181-183) |
| `n-error` | node | `src/mcp.rs:164` | outcome? : an engine error propagates as Err(VigilError) before the flush (src/mcp.rs:164) |
| `n-cancelled-result` | node | `src/mcp.rs:188-190` | cancelled_result(): the tool replies with the text "cancelled" flagged as an error (src/mcp.rs:188-190) |
| `e-runs-work` | edge n-run -> n-engine [runs work] | `src/mcp.rs:140-142` | run_keepalive starts the work with the cancel future |
| `e-forwards` | edge n-run -> n-forward [forwards progress] | `src/mcp.rs:143-153` | run_keepalive races the work against the progress forwarder |
| `e-queues` | edge n-engine -> n-forward [queues progress] | `src/mcp.rs:141-142` | the engine reports progress into the channel sink that feeds the forwarder |
| `e-engine-flush` | edge n-engine -> n-flush [then flushes] | `src/mcp.rs:155-164` | when the engine returns, what is queued is still sent, briefly, within the call's window (A20) |
| `e-flush-recheck` | edge n-flush -> n-recheck [then rechecks cancel] | `src/mcp.rs:165-175` | after the flush the cancel flag from the flush is combined with one more cancel poll |
| `e-recheck-none` | edge n-recheck -> n-return-none [cancel seen] | `src/mcp.rs:181-183` | a cancel seen by either check returns Ok(None) without committing |
| `e-recheck-commit` | edge n-recheck -> n-commit [no cancel, commits] | `src/mcp.rs:184` | no cancel seen: commit_delivery runs after the cancellation checks |
| `e-commit-return` | edge n-commit -> n-return-some [then returns] | `src/mcp.rs:185` | after the commit the envelope is returned |
| `e-engine-none` | edge n-engine -> n-return-none [no result] | `src/mcp.rs:174` | the engine returned no result (cancel completed during the work): early Ok(None) |
| `e-engine-error` | edge n-engine -> n-error [fails] | `src/mcp.rs:164` | an engine error is returned before any flush or commit |
| `e-none-cancelled` | edge n-return-none -> n-cancelled-result [reported as cancelled] | `src/mcp.rs:278-279` | the tool handler maps Ok(None) to cancelled_result() |

### vigil-one-write (example, snapshot vigil-d064373)

Does one write after watch creation reach the first keepalive result?

Completeness: partial - gaps: observed-run-missing, adapter-missing. Sources: s-e2e = tests/mcp_e2e.rs.

| item | kind | read at | fact |
|---|---|---|---|
| `scenario-one-write` | scenario | `tests/mcp_e2e.rs:112-156` | tests/mcp_e2e.rs:112-156 writes boot, creates watch build (fire change, interval_s 1, deadline_s 3600), appends one ERROR line, calls keepalive and asserts status fired, tick 1, next act on events, event_id build:1:0 |

### vigil-cancel-guard (source, snapshot vigil-d064373)

Which exact code checks cancellation before the delivery is committed?

Completeness: complete - the cited lines 155-185 of src/mcp.rs, quoted verbatim; nothing outside them is claimed. Sources: s-mcp = src/mcp.rs.

| item | kind | read at | fact |
|---|---|---|---|
| `x-cancel-guard` | excerpt | `src/mcp.rs:155-185` | run_keepalive after the engine returns: flush, cancel checks, commit (src/mcp.rs:155-185) |
| `a-bound` | annotation | `src/mcp.rs:155-160` | The flush is bounded: min(PROGRESS_FLUSH, what is left of the call's own max_s) (A20). |
| `a-flush-cancel` | annotation | `src/mcp.rs:161-173` | Cancel is raced against the flush (C2). |
| `a-recheck` | annotation | `src/mcp.rs:175-180` | One more cancel poll after the flush. |
| `a-return-none` | annotation | `src/mcp.rs:181-183` | A cancel returns Ok(None). |
| `a-commit` | annotation | `src/mcp.rs:184-185` | commit_delivery follows both checks. |

### residual-view-entrypoints (list, snapshot residual-32c0836)

Which views exist, and which code owns them?

Completeness: complete - the three declared LandscapeView choices bundle, heatmap and regions (web/src/nkp-landscape.ts:22-24); dynamic behavior and other UI panels are not claimed. Sources: s-land = web/src/nkp-landscape.ts.

| item | kind | read at | fact |
|---|---|---|---|
| `row-bundle` | row | `web/src/nkp-landscape.ts:245-246` | bundle: created by createBundleView in ensureViewHandle (web/src/nkp-landscape.ts:245-246) |
| `row-heatmap` | row | `web/src/nkp-landscape.ts:247-248` | heatmap: created by createHeatmapView in ensureViewHandle (web/src/nkp-landscape.ts:247-248) |
| `row-regions` | row | `web/src/nkp-landscape.ts:249-255` | regions: created by createRegionsView in ensureViewHandle (web/src/nkp-landscape.ts:249-255) |

### residual-selection-shape (shape, snapshot residual-32c0836)

What identity survives switching the drawing?

Completeness: complete - the three variants of the EntityKey union declared at web/src/landscape-selection.ts:15 (component, force, attractor), with the selection state of mountLandscape and the EntityDetail type and functions named in the fields. Sources: s-land = web/src/nkp-landscape.ts; s-sel = web/src/landscape-selection.ts.

| item | kind | read at | fact |
|---|---|---|---|
| `f-root` | field selection | `web/src/nkp-landscape.ts:158-167` | mountLandscape owns the cross-view selection; it survives view switches and filter changes (doc web/src/nkp-landscape.ts:158-167) |
| `f-selected` | field selection.selected | `web/src/nkp-landscape.ts:176` | let selected = new Set<EntityKey>() inside mountLandscape (web/src/nkp-landscape.ts:176) |
| `f-active` | field selection.activeKey | `web/src/nkp-landscape.ts:177` | let activeKey: EntityKey \| undefined inside mountLandscape (web/src/nkp-landscape.ts:177) |
| `f-module` | field landscape-selection | `web/src/landscape-selection.ts:7-10` | landscape-selection.ts is the pure, DOM-free half; mountLandscape owns the actual Set (web/src/landscape-selection.ts:7-10) |
| `f-key` | field landscape-selection.EntityKey | `web/src/landscape-selection.ts:15` | export type EntityKey, a union of three template-literal types (web/src/landscape-selection.ts:15) |
| `f-key-component` | field EntityKey.component | `web/src/landscape-selection.ts:15` | variant: component:<name> (web/src/landscape-selection.ts:3, :15) |
| `f-key-force` | field EntityKey.force | `web/src/landscape-selection.ts:15` | variant: force:<EffectiveForce.key> (web/src/landscape-selection.ts:3, :15) |
| `f-key-attractor` | field EntityKey.attractor | `web/src/landscape-selection.ts:15` | variant: attractor:<id> (web/src/landscape-selection.ts:3, :15) |
| `f-detail` | field landscape-selection.EntityDetail | `web/src/landscape-selection.ts:17-23` | export interface EntityDetail, the card the sidebar shows (web/src/landscape-selection.ts:17-23) |
| `f-detail-key` | field EntityDetail.key | `web/src/landscape-selection.ts:18` | EntityDetail.key: key: EntityKey (web/src/landscape-selection.ts:18) |
| `f-detail-kind` | field EntityDetail.kind | `web/src/landscape-selection.ts:19` | EntityDetail.kind: the detail kind, not the key variant (web/src/landscape-selection.ts:19) |
| `f-detail-title` | field EntityDetail.title | `web/src/landscape-selection.ts:20` | EntityDetail.title (web/src/landscape-selection.ts:20) |
| `f-detail-color` | field EntityDetail.color | `web/src/landscape-selection.ts:21` | EntityDetail.color?: optional (web/src/landscape-selection.ts:21) |
| `f-detail-fields` | field EntityDetail.fields | `web/src/landscape-selection.ts:22` | EntityDetail.fields (web/src/landscape-selection.ts:22) |
| `f-entity-detail` | field landscape-selection.entityDetail | `web/src/landscape-selection.ts:44-45` | entityDetail: returns undefined when the key no longer exists in the state (web/src/landscape-selection.ts:44-45) |
| `f-toggle` | field landscape-selection.toggleSelection | `web/src/landscape-selection.ts:345-351` | toggleSelection: no-modifier toggle that returns a new Set and does not mutate its input (web/src/landscape-selection.ts:345-351) |

### residual-selection-switch (example, snapshot residual-32c0836)

Does a selection survive a view switch and a filter change?

Completeness: partial - gaps: observed-run-missing, adapter-missing. Sources: s-test = web/src/nkp-landscape.test.ts.

| item | kind | read at | fact |
|---|---|---|---|
| `scenario-selection-switch` | scenario | `web/src/nkp-landscape.test.ts:336-364` | web/src/nkp-landscape.test.ts:336-364 clicks the auth bundle leaf, then picks heatmap and regions (selection survives a view switch), then flips the hide-filtered toggle (selection survives a filter change); clicking a leaf is :270-277 |

### residual-key-union (source, snapshot residual-32c0836)

Which exact code declares the key variants of a selection?

Completeness: complete - the cited lines 1-15 of web/src/landscape-selection.ts, quoted verbatim; nothing outside them is claimed. Sources: s-sel = web/src/landscape-selection.ts.

| item | kind | read at | fact |
|---|---|---|---|
| `x-key-union` | excerpt | `web/src/landscape-selection.ts:1-15` | header comment, imports and the EntityKey declaration (web/src/landscape-selection.ts:1-15) |
| `a-key-space` | annotation | `web/src/landscape-selection.ts:1-5` | One key space spans all three views. |
| `a-owner` | annotation | `web/src/landscape-selection.ts:7-10` | mountLandscape owns the Set; this module is pure. |
| `a-union` | annotation | `web/src/landscape-selection.ts:15` | The EntityKey union. |

### story-context-change (notebook, snapshot story-1)

Does changing the caller's context lose a result or a selection, and which evidence and views answer that?

Completeness: partial - gaps: vigil-run-missing, residual-run-missing. Sources: sv = src/mcp.rs; sr = web/src/nkp-landscape.test.ts; sd = docs/design.md.

| item | kind | read at | fact |
|---|---|---|---|
| `intro` | block prose | `(no anchor: composed from the cited sources)` | What survives a change of context? |
| `v1` | block view | `(no anchor: composed from the cited sources)` |  |
| `v2` | block view | `(no anchor: composed from the cited sources)` |  |
| `v3` | block view | `(no anchor: composed from the cited sources)` |  |
| `D1` | block claim | `(no anchor: composed from the cited sources)` | The MCP wrapper checks cancellation before committing delivery. |
| `r1` | block view | `(no anchor: composed from the cited sources)` |  |
| `r2` | block view | `(no anchor: composed from the cited sources)` |  |
| `r3` | block view | `(no anchor: composed from the cited sources)` |  |
| `D2` | block claim | `(no anchor: composed from the cited sources)` | The tests specify selection persistence across view and filter changes. |
| `D3` | block claim | `(no anchor: composed from the cited sources)` | Does this checkout satisfy both runnable scenarios? |
| `ex1` | block example | `(no anchor: composed from the cited sources)` |  |
| `ex2` | block example | `(no anchor: composed from the cited sources)` |  |

## Round 2 evidence corrections

D2 records the actual assertions in residual's two separate bun:test cases.
They check sidebar text containing auth after heatmap/regions switches, and
after enabling hide-filtered in another case. They do not assert selected-key
identity. The scenario parameters name that assertion and the separate cases.
The entrypoint rows already cite factory calls inside mountLandscape at
245-255; the parser note includes lines 43-45.

Story blocks v3 and ex1 now cite sv-e2e, the declared tests/mcp_e2e.rs source,
whose hash is also in story freshness. D1 retains sv for src/mcp.rs. The
cancelled_result node already says the returned text is flagged as an error.
All examples retain empty runs and read provenance.
