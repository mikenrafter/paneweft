# Contract additions: nav slice (MC7 reducer, MC8 links, MC9 layout, MC12 registry, MC15 markdown)

Each entry: the question, the default the red tests pin (`[test file]`), and why. All are proposals; overturn by
editing the cited test.

## Inspector reducer (MC7) [src/core/inspector.test.ts, inspector.model.test.ts]
1. **Notices name what they refuse.** Contract section 4 gives notice codes but no message text. Tests require
   `notice.message` to contain the pane index (NO_SUCH_PANE), item id (UNRESOLVED_TARGET, NO_TARGET), view id (UNKNOWN_VIEW on
   switchView) or entity id (UNKNOWN_VIEW on open). Reason: "named unresolved result" (design 3) and a message-free notice is
   not actionable. Also lets the tests fail against the stub.
2. **`open` with a preferred view the entity does not have** falls back silently to `world.initialView` (no notice);
   UNKNOWN_VIEW only when the entity has no view at all in that snapshot. The brief's "unknown view -> UNKNOWN_VIEW"
   is read as "the entity has no applicable view". Alternative: unknown preferred id also UNKNOWN_VIEW.
3. **Unknown action type** (untyped caller): state unchanged plus a notice whose message contains the action type. No code is
   pinned (the five codes do not fit). Proposal: add `UNKNOWN_ACTION` to `InspectorNoticeCode`.
4. **Not specified, not tested:** `select` whose target entity has no initial view in the snapshot (world inconsistency);
   `pin` on a retained pane; negative or non-integer indexes beyond "out of range".
5. `pin` on an already pinned pane: unchanged state, no notice, no history.

## Registry (MC12) [src/core/registry.test.ts]
1. **Built-in order vs user priority.** Contract says built-ins are "always appended" AND have priorities 1000/1001. A user
   definition with priority 5000 is therefore ambiguous (sorted after the built-ins, or built-ins always last). Tests never use a
   priority above 999. Proposal: exact-kind views always precede the built-ins (append rule wins).
2. **Instance unsupported AND roles missing:** which availability wins is unspecified; tests avoid the combination.
   Proposal: `needs_data` first (cheaper to fix), then `unsupported`.
3. Built-in `title` and `component` are unspecified; only id, priority, `fallback: true` and availability are pinned.
4. `fallbackFrom.reason` must contain the missing role (needs_data), the instance's reason (unsupported) or the requested id
   (unregistered / other-kind id); exact wording is free.

## Links (MC8) [src/core/links.test.ts, fixtures/nav/*]
The stub types leave the resolution object's optional keys open. Pinned (toStrictEqual):
1. View link resolved: `{status, snapshotId, viewId, viewDefinitionId}` plus `itemId` when an item was given, plus `entity`
   only if the item carries `entity` (for an example run: its `result`). No `entity` for a bare view link.
2. Entity link resolved: `{status, snapshotId, entity, viewDefinitionId}` plus `viewId` only when a stored instance of that
   definition exists for that entity at that snapshot; `fallback{requested, used, reason}` only when a preference was given and
   could not be used. Built-in views never have a `viewId`.
3. Precedence of misses: snapshot, then view, then item (an unknown snapshot is reported as the snapshot).
4. `resolveItemSource`: `stored.lines` are the stored excerpt lines of the **anchor range only** (not the whole excerpt);
   `highlight` equals the anchor lines; an anchor is covered only if both ends lie inside one stored excerpt of the same
   repository and path in the same snapshot. Currency: file bytes differ or file gone under an accessible root -> `stale`
   (`currentSha256` null when gone); repository unregistered or root missing -> `unknown` (`currentSha256` null);
   `recordedSha256` always the envelope's `freshness.files[path]`. Alternative for lines: whole excerpt + highlight subrange.
   `origin` is `stored-excerpt` for the above. **No covering excerpt (#19):** the anchored lines are read from the registered root
   through the confined read path (at most 16 MiB) and shown, with `origin: "registered-root"`, `stored.viewId: null` and currency
   `fresh`, only when the bytes read hash to the hash the view recorded. Otherwise `UNRESOLVED_TARGET` whose message names the
   missing excerpt (`<path>:<a>-<b>`), why the file was not used (repository not registered, hash differs, too large, lines out of
   range, not found) and the fix (register the root, or submit a source view covering the lines).
5. `resolveClaimEvidence`: `EvidenceStep.target` cannot represent a bare source-id target (`supports: ["s1"]`), so the fixtures
   use only `{viewId, itemId}` targets. Proposal: source-id targets are omitted from the steps (or `LinkTarget` gains a
   source variant). Targets resolve in the claim view's own snapshot. An unknown item is an unresolved step in place.
6. Bundle import is assumed NOT to reject a `{viewId,itemId}` target whose item is missing (contract section 2 lists only
   the `viewId` as a reference check). One test depends on this.

## Layout (MC9) [src/core/layout.test.ts]
1. `graphNeighborhood` with an unknown focus node returns `{nodeIds: [], edgeIds: []}`.
2. "Traversed" means: every edge examined from a node expanded within `depth` steps in an allowed direction, including an edge
   closing onto an already visited node (c out depth 3 includes b->c). The alternative (tree edges only) would drop such
   closing edges; the tests pin the first reading.
3. Grid self loops and grid layout of an empty graph are unspecified and untested (empty layered is 32 x 32).
4. Width/height use the layered formulas with `maxLayer = cols-1`, `maxRows = ceil(n/cols)` for the grid.

## Markdown (MC15) [src/core/markdown.test.ts]
1. Dialect: CommonMark blocks and inlines (ATX headings, `-`/`1.` lists, `>`, fenced code, `---`, two-space hard break, reference
   links, destinations with surrounding spaces). Entity decoding is NOT pinned (`&lt;b&gt;` may show as `<b>` or `&lt;b&gt;`).
2. Images: no `<img>`/src; the alt text stays visible as text. Whether an image also becomes a link is free.
3. Href case: scheme/host may be lowercased; tests compare case-insensitively.
4. `isSafeLinkUrl`: http/https only, scheme case-insensitive, non-empty host, **no whitespace or control characters anywhere**,
   no trimming. `mailto:` and `#fragment` are false here (the stub doc says http/https) while `renderMarkdown` renders them as
   links. The asymmetry is deliberate; flagging it because two allowlists can drift.
