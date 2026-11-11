# Contract additions: demos (tag `demo`)

Questions the design and `docs/red-contract.md` leave open for the demo fixtures (`fixtures/demos/`) and the suites
`test/demos.test.ts` (red) and `test/scaffold/demos.scaffold.test.ts` (green). Each entry has a proposed default; tests that
rely on one cite its id (A1..A10) in their `why`. Where I think the design is wrong, it says so.

## A1. The page's two example blocks (design prose vs design JSON)

Design 6 prose: "The page links `D3` to the two example blocks and names the missing observed runs." The design's JSON has no
`example` block at all (ten blocks: `intro v1 v2 v3 D1 r1 r2 r3 D2 D3`). The two cannot both be literally true.

**Default (implemented):** the fixture keeps the design's ten blocks, unchanged and in order, and appends `ex1`
(`exampleId: vigil-one-write`) and `ex2` (`exampleId: residual-selection-switch`) after `D3`. The JSON stays a subset of the
fixture. "Links D3 to" is expressed as two envelope `links` with relation `open question examined by`
(`l-D3-ex1`, `l-D3-ex2`, `itemId` = `ex1` / `ex2`, in the page's own snapshot), because a notebook `claim` block has no field
that can point at blocks (`supports`/`contradicts` are evidence *for* the claim, and D3 has none). "Names the missing observed runs"
is the page's `completeness`: `partial` with gaps `vigil-run-missing` and `residual-run-missing`. Alternative: link by block
order only (ex1, ex2 directly after D3) and no `links`; rejected because a person or agent could not follow it.

Note on evidence: `ex1` cites `sv` and `ex2` cites `sr`, as the design's `v3` and `r3` do, although the underlying files for the
scenarios are `tests/mcp_e2e.rs` and `nkp-landscape.test.ts`; the page registers only `sv`, `sr`, `sd` (design 6), and `sv` is
`src/mcp.rs`, not the e2e test. Design-side inconsistency, kept as written.

## A2. `exampleId` references an example **view** id and is checked like `viewId`

Design 2.6 has `{kind:"example"; exampleId: string}` without saying what it names. red-contract section 2 lists only
`viewId` among the notebook references. **Default:** `exampleId` is the id of an example-component view (here the same string as
the view id and as the scenario's `runnerId`), and in a bundle an unknown one is `DANGLING_REFERENCE` at
`.../blocks/N/exampleId`, exactly like `viewId`. Reason: an unchecked reference lets an impossible page in. Only one
test depends on this (`[MC2] (A2) ...`); the six-`viewId` test filters its issues to the `viewId` pointers so it holds either way.

## A3. Cross-snapshot embeds are addressed by envelope `links`

A notebook `view` block holds only a `viewId`, but the six views live in two other snapshots (`vigil-d064373`,
`residual-32c0836`) and design 6 says "Evidence links retain each view's repository and revision rather than forcing one
synthetic revision". **Default:** the page's `links` array carries one `embeds view` link per embedded view with its snapshot
(`l-v1`..`l-r3`), plus `claim D1 is shown by source` (`l-D1-recheck`, `l-D1-commit`) and `claim D2 is specified by test scenario`
(`l-D2-switch`). Resolution of a block's `viewId` should use the link with that `viewId`. **Not asserted anywhere:** whether
`validateSubmission` checks link targets (red-contract section 2 does not list `links`); the tests are written so the validator may or may not.
The fixture's links are all valid (the scaffold checker verifies snapshot and item ids) so either choice accepts it.

## A4. What `EvidenceStep.target` is for a source-id evidence target

`resolveClaimEvidence` returns `{target: LinkTarget, resolution, relation}`, but D1's `supports` is `["sv"]`, a **source id**, and
`LinkTarget` has no source-id shape (design 6: "D1's `supports` are SOURCE ids"; design 4 allows source ids or `{viewId,itemId}`).
**Default:** a source-id target produces a step whose `target` names the source (for example `{snapshotId, sourceId}`) and whose
`resolution.status` is `resolved` when the envelope registers that source. The tests require only: one step, `relation: "supports"`,
resolution `resolved`, and the source id `sv` / `sr` appearing in the step's JSON. Please add `sourceId` to `LinkTarget` in the
stub when the shape is decided; I did not edit `src/core/links.ts` (not in my assignment).

## A5. `resolveItemSource` on an item that is not a source annotation

`links.ts` says it "opens the stored excerpt that covers the item's anchor (an item with an anchor, or a source view's annotation)".
Design 6 says "a cancellation edge opens source". The delivery graph's edges are anchored in `src/mcp.rs`; the excerpt that
covers them is a *different* view (`vigil-cancel-guard`). **Default:** for an item with an anchor, search the session's `source` views of the
**same snapshot** for an excerpt of the same repository and path whose lines cover the anchor; the result's `stored.viewId` names
the excerpt's view and `highlight` is the item's anchor range. No covering excerpt (the lifecycle's `engine.rs` edges) is
`UNRESOLVED_TARGET`, never a silent empty opening. The currency state is not asserted (no root is registered in the tests).

## A6. What the header's `provenance:` counts

red-contract section 3 says `provenance` counts "the whole view" but not which objects. **Default:** every `Item` in `data`:
graph nodes + edges, list rows, shape fields, source excerpt + annotations, notebook blocks, example scenario + runs + assertions.
Hand counts: lifecycle 4+10=14, delivery 10+11=21, one-write 1, cancel-guard 1+5=6, entrypoints 3, selection-shape 16,
selection-switch 1, key-union 1+3=4, story 12. (Alternative: only the primary collection, which would make graph counts edges only; rejected because
`provenance` and `counts` would then say different things about the same view.)

## A7. `counts` for a `source` view

Unit `lines` (red-contract section 3) with `total` = the number of excerpt lines (31 for `vigil-cancel-guard`, 15 for `residual-key-union`),
not the number of annotations. The only test that touches it is `[MC14] all nine demo views return every item within 8192 bytes`.

## A8. Document source and the third repository of the page

Design 4: "document sources identify a path or URL", and "full repository freshness includes every file that supported the answer".
`sd` is the design note, which the page cites as the origin of its question. **Default:** `sd` is
`{kind: document, repository: "paneweft", path: "docs/design.md", sha256: <bytes at fixture-writing time>}` and the page's
`freshness` has a third repository entry `paneweft` (root `/home/mini/Documents/repos/paneweft`, `gitRev` = the last commit that touched
the file, `31aae89...`), so `scope.repositories` is `[vigil, residual-web, paneweft]`. Design 6 says "Scope names both repository
snapshots"; the design note itself is a third thing the page cites. Alternative: no repository and no freshness for `sd`, which
could never go stale; rejected.

## A9. Nine views, not six (3+3+1)

Design 6 lists six views. Its own navigation story ("page -> vigil delivery -> **cancellation source** -> example result",
"page -> residual selection shape -> **key variant** -> example result") needs two more: a `source` view of the cancellation check
(`vigil-cancel-guard`, `src/mcp.rs:155-185`) and one of the key declaration (`residual-key-union`,
`web/src/landscape-selection.ts:1-15`). **Default:** add them, so the totals are 4+4+1 = 9 views, 3+6+1 = 10 entities and
4+4+1 = 9 definitions. **The design's table is incomplete on this point.** The page embeds only the design's six (blocks
`v1..v3`, `r1..r3`), not the two source views; they are reached by links.

## A10. Modeling choices that look odd in a viewer

* Shape `presence` for the three `EntityKey` variants is `optional` ("a value has one of them"); `required`/`optional` do not
  have a union meaning in design 2.5. `ref` is used to point at the `EntityKey` type from the places that use it (a type reuse, not
  only recursion).
* The graph `layout` is `layered` with self-loops (`cancel keeps result`, `tick writes nothing`): design 2.3 "cycles remain
  visible".
* Header `evidence: sources=` is read as the ids cited by the view's items; in all nine demo views that equals the envelope's
  `sources` (the scaffold suite checks that no source is orphaned), so the test is order-insensitive and independent of the reading.
* The story's `entity` is `notes/page:context-story` in repository `paneweft`, snapshot `story-1`; its relations point (softly) at the two
  scenario entities.
