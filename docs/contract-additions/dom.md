# DOM contract additions (test agent `dom`)

`docs/viewer-dom-contract.md` names the `data-pw` elements but leaves their nesting, texts and several
interactions open. The goldens and DOM tests pin the choices below. Each is a PROPOSED DEFAULT; the owner can
overturn any of them, in which case the goldens in `test/goldens/*.outline.txt` change by review (never by
regeneration). Items marked **[contract]** are the DOM contract's own words; everything else is an addition.

## A. Mount, history, bundle

* **A1 Back.** Every inspector action that changes `{trail, retained}` calls
  `history.pushState({ paneweft: <InspectorState> }, "")`. A `popstate` whose `state.paneweft` is present restores
  that state (re-render, no new push). Tests use `history.back()` and await the `popstate` event.
* **A2 Bundle global.** The IIFE `dist/viewer/app.js` exposes `window.paneweft = { mountViewer }` and, when
  `location.hash` carries `token=` plus `view=`/`snapshot=` (the `viewerUrl` of `render`), mounts into
  `#root` over `createHttpSource(location.origin, token)`. Every request it issues targets the page origin with
  `Authorization: Bearer <token>`; the bundle contains no other absolute URL than XML namespace URIs. **[contract]**
  (no CDN, design 5) for the last part; the global and hash handling are additions.
* **A3 Keyboard activation.** Keys are handled on `keydown` (Enter and Space activate; the handler calls
  `preventDefault`), so a test that only dispatches `KeyboardEvent`s drives the whole route.
* **A4 Narrow.** A viewport narrower than 640 px (`MountOptions.viewport.width`) is narrow: exactly one `pane`
  is visible (the active one, by default the last trail pane); other panes carry the `hidden` attribute (or are
  absent). Wide shows every trail pane. Clicking `crumb i` in narrow mode makes pane `i` the visible one and
  moves `aria-current="page"` to it; the inspector state is untouched.
* **A5 Pin.** `pin` is one-way (`pinned := true`, red-contract 4); pressing it again changes nothing.

## B. Pane layout (child order inside `viewer`)

```
viewer
  pane-trail (aria-label="Pane trail") > crumb*              crumb text = entity label
  pane*  (aria-label = entity label, data-pane-index, data-entity-id, data-snapshot-id, data-view-id, data-pinned)
    pin (text "Pin")
    view-tabs (role=tablist, aria-label="Views") > tab*      available views only, priority then id; text = view title
    needs-evidence?                                          only when unavailable views exist
    status-strip > completeness, freshness, snapshot, provenance-summary, evidence-coverage
    filter-input, match-count                                not for an unsupported view
    tabpanel (role=tabpanel, labelled by its tab) > [ empty-state | component root ]
    source?                                                  see E3
  error*                                                     direct child of viewer (failed open) or inside tabpanel (failed view load)
```

* Built-in views are tabs like any other: `builtin:metadata`, `builtin:raw` come last. Their text is not pinned by
  the goldens (the golden helper strips it); their content is out of scope here.
* `tab` has an `id`; `aria-controls` is the id of the (single) `tabpanel`; the tabpanel's `aria-labelledby` is
  that tab's id. Arrow keys on a tab move focus **and** select (automatic activation), wrap around, Home/End go
  to the ends. **[contract]** roving `tabindex` (`0` selected, `-1` others), `aria-selected`.
* Status strip texts (the value part of the red-contract 3 header lines):
  `completeness`: `complete (<criterion>)` | `partial (<n> gaps; first: <gap id>: <gap question>)` |
  `unsupported (<reason>; missing: <cap>, <cap>)`; `freshness`: `fresh` | `stale (changed: <path>, <path>)` |
  `unknown (inaccessible: <root>, <root>)`; `snapshot`: the id; `provenance-summary`:
  `read=N parsed=N compiled=N observed=N inferred=N` over every Item of the view (rows, nodes, edges, fields,
  blocks, excerpt+annotations, scenario+runs+assertions), unfiltered; `evidence-coverage`:
  `sources=<id>,<id>` = ids cited by at least one Item, in code-unit order (new element; the contract asks that a
  filtered-empty view "still reports its evidence coverage").
* `match-count`: text `<M> of <T> match`, `data-matched`, `data-total`. Units are the red-contract 3 units: list
  rows, tree nodes, graph **edges**, source lines, shape fields, notebook blocks, example runs. Tree ancestors kept
  as filter context are not counted in `data-matched`. `filter-input` text filter = red-contract 3 `text`.
* `empty-state` exists for list, tree, graph, shape, notebook only. Complete and `total = 0`:
  `0 items within this scope` **[contract]**. Partial and `total = 0`:
  `no items returned; completeness is partial: <gap id>: <gap question>` (first gap; differs from the former, names
  the gap) **[contract]** ("a different message that names the gaps"). `matched = 0 < total`:
  `no items match the current filters (0 of <T>)` **[contract]**. An example with no runs shows `not-run` instead.
* `error`: `role="alert"`, `data-code` = the Result's code, text `<code>: <message>`. **[contract]**
* Unsupported views are not displayed as the pane's view (they are unavailable in `rankViews`). They appear in
  `needs-evidence` as `unavailable-view` (text: view title and the reason) and, when embedded in a notebook,
  `embedded-view` shows their `completeness data-status="unsupported"` with the reason and no component element.

## C. Facts

Every fact element (`row`, `node`, `field`, `graph-node`, `graph-edge`, `block`, `run`, `assertion`, `scenario`;
and `fact` for the source excerpt and each annotation) has children in this order: component parts,
`provenance-badge` (text = provenance word), `inferred-reason` (inferred only; text = `reason`), one `evidence-link`
per evidence id (`data-source`, text = id, declared order), `no-target`, `actions-button`.

* `no-target` (text `no entity or source`) only on list rows, tree nodes, graph nodes and shape fields that have
  neither `entity` nor `anchor`. Such an item has no `actions-button`. Activating `no-target` creates no pane.
* `actions-button`: `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Actions for <item id>"`, text `...`.
  `actions-menu` (`role=menu`) exists only while open, as the next sibling of its button, containing `menu-item`
  (`role=menuitem`, `tabindex=-1`, `data-kind`) in the order `open-entity` (item has an entity), `open-source`
  (item has an anchor, or is a source annotation). Enter/Space on the button opens it and focuses the first item;
  ArrowDown/Up move; Escape closes it and focuses the invoking button. **[contract]** for Escape and focus return.
* In graphs the SVG items carry only badge/reason/evidence-links (a node's evidence links are the node's following siblings, review round 2 S9); the actions of an edge live on its
  `graph-edge-item` (HTML list). Graph nodes open their entity on Enter/click.
* Enter, or a click, on a focused `row`/`node`/`field`/`graph-node` selects it (`aria-selected="true"`, pane
  selection `[id]`) and opens its entity in the next pane (red-contract 4 `select`).
* Rows and tree nodes use roving `tabindex` (the first/selected item `0`, the others `-1`); ArrowDown/Up move
  between rows and nodes.

## D. Components

* Roots carry `aria-label` = view title: `list` (`role=grid`), `tree` (`role=tree`), `shape` (`role=tree`,
  `data-kind`), `graph` (`role=group`, see D1), `source`/`notebook`/`example` (`role=region`).
* **List**: `column-header*` (`role=columnheader`; text = title; `aria-sort="ascending|descending"` on the sorted
  one only), then per group a `group` (`role=row`, text = label) **followed by** its rows (siblings), groups in
  code-unit order of label, rows by `order` (numeric compare for `number` columns) then item id. `cell` text:
  numbers via `Intl.NumberFormat(locale)`, text verbatim.
* **Tree**: flat pre-order list of `node`s, children after their parent, `aria-level` = depth + 1; only nodes under
  an expanded ancestor are rendered. Initially depth-0 nodes are expanded, all others collapsed. Children of a
  node: `toggle` (button, `aria-label="Toggle <id>"`, no text; only on nodes with `aria-expanded`), `cell*`
  (no role), then the fact children, `load-affordance` (text `needs evidence: children not loaded`) after the
  evidence links. Filtering expands the ancestors of matches.
* **Graph**: children of `tabpanel`: `relation-filter*` (one element **per relation**, an `<input type=checkbox>` with
  `data-id` = relation and `aria-label="Show <relation>"`, relations in code-unit order, all checked initially), `graph`, `graph-edge-list`. Inside
  `graph`: `layout-info` (text `W x H`), `graph-node*` and `graph-edge*` sorted by id independent of input order.
  `graph-node`: `role=button`, `tabindex=0`, `data-group` when grouped, `data-x`, `data-y`; text = label (else id).
  `graph-edge`: children `edge-path` (`d`), `edge-label` (relation), `edge-note` when the edge has a `label` (at most 28 characters, `…` marks a cut, `<title>` child with the whole label; #12), then fact children.
  `graph-edge-item`: text `<from> -<relation>-> <to>` (item ids), children `edge-list-label` (the whole label, when present; #12) and `actions-button`.
  An unchecked relation removes its edges from `graph` and from `graph-edge-list`; nodes stay.
  Focus mode: only `graphNeighborhood` nodes rendered, the focus node has `data-status="focus"`, and
  `omitted-neighborhood` (sibling of `graph`) reads `<k> nodes omitted by focus`.
* **Source**: children: `fact` (excerpt: `source-origin`, badge, links), `source-line*`, then one `fact` per
  annotation in declared order containing the `annotation` button (text `<message> (claims: C1, C2)`, or just the
  message without claims). `source-origin` text `<repository> <revision | no revision> <path>` (single spaces,
  revision = the envelope's recorded `gitRev`). Lines always render from the stored excerpt with
  `data-highlighted="false"`; activating an annotation highlights its lines and asks
  `source.openItemSource`. `currency.state = stale` adds `stale-notice` (text names the hash mismatch and that
  the stored excerpt is shown) **[contract]**; `unknown` adds `unknown-notice` (text says the currency is unknown and
  why) (new); fresh adds neither.
* **Shape**: pre-order flat `field`s like the tree (`aria-selected`, roving tabindex, `toggle` when it has
  children, initially depth-0 expanded). Parts: `field-path` (the path as text; #9), `field-label` (when the field has a label; #9), `field-type`, `field-example` (`JSON.stringify` of the scalar, so
  the string `"null"` shows with quotes and `null` without; absent -> `no example`) **[contract]** for the last
  two, `field-ref` (text `ref: <path of the referenced field>`).
* **Notebook**: `claim-filter` (`<select aria-label="Claim status">`: `all`, `supported`, `disputed`, `open`), then
  `block`s in declared order. Claim and view blocks are collapsed (`aria-expanded="false"`) with a `toggle`;
  prose blocks have no `aria-expanded`. A claim shows `claim-status` always **[contract]**, its statement as the
  block's own text, and only when expanded its `evidence-link`s for `supports` (`data-kind="supports"`) and
  `contradicts` (`data-kind="contradicts"`) (an unresolved target explanation, `no-target` or `error`, appears inside the same block); a source id target has `data-source`, a `{viewId,itemId}` target has
  `data-view-id`/`data-id` and text `<viewId>#<itemId>`. `embedded-view` text = embedded view title, child
  `completeness` (collapsed); expanded adds the embedded component root (one level). Activating an unresolvable
  evidence target shows `no-target` or `error` naming the missing view/item and creates no pane.
* **Example**: `scenario` text `<label> (<runnerId>)`; `not-run` (text `not run`) iff `runs` is empty; each `run`
  (text `<runId>: <status>`; `data-id`, `data-provenance`, `data-run-id`, `data-status`) contains `assertion`s
  (text `<statement> PASS|FAIL`, `data-passed`), `result-link` (text `<kind>:<id>` of `result`, opens that
  entity), then the fact children; `rerun-instruction` (text `paneweft example run <runnerId>`) always last.

### D1. Where the DOM contract conflicts with ARIA (found by axe-core, evidence in `src/viewer/keyboard.test.ts`)

* **Graph root is `role="group"`, not `role="img"`.** The contract asks for `<svg role="img">` that contains focusable
  `graph-node`s. `img` makes its descendants presentational, and axe-core reports `nested-interactive` for the focusable
  nodes inside it. `role="group"` with the same `aria-label` keeps the name and lets the nodes stay focusable.
* **`aria-expanded` of a notebook block lives on its `toggle` button**, not on `block`: a `div` without a widget role may not carry
  `aria-expanded` (axe `aria-allowed-attr`). `block` has no `aria-expanded`; `toggle` of claim/view blocks has
  `aria-expanded="true|false"`. (Tree nodes and shape fields are `treeitem`s, which may carry it, so there it stays on the item.)
* **List grid structure.** `role=grid` needs `row` children and `role=row` needs cell children (axe
  `aria-required-children`/`aria-required-parent`): put the `column-header`s inside a `role=row` wrapper and the non-cell parts of
  a row (badge, reason, evidence links, `no-target`, `actions-button`) inside one trailing `role=gridcell` wrapper. The wrappers carry
  no `data-pw`, so outlines are unaffected.

## E. Source click-through

* E1 Annotation activation and the `open-source` menu item both call `source.openItemSource(key, itemId)`.
* E2 `stale`/`unknown` never hide the stored excerpt.
* E3 `open-source` from a non-source view renders a `source` element (same structure as D, lines from
  `SourceOpening.stored.lines`, highlight from `highlight`) as the last child of that `pane`; no pane is created.

## F. Test harness choices

* vitest's jsdom environment does not run scripts by default; `escape.dom.test.ts` opts in with
  `// @vitest-environment-options {"runScripts":"dangerously"}` and proves with a positive control that a script
  element and an `onclick` handler do execute there. Because the page's `window` differs from the test global,
  payloads mark execution with `document.documentElement.setAttribute('data-pwned','1')` besides `window.__pwned`.
* Goldens run over `createSessionSource(session)` wrapped so freshness is `fresh` (freshness has its own tests).
* `viewerOutline()` (test/helpers/dom-harness.ts) normalises what the contract leaves to the implementation: the text of
  the two built-in tabs, the own text of container elements (`viewer`, `pane`, `tabpanel`, `claim-filter`,
  `relation-filter`, component roots, ...: control labels and option texts live there), and `role`/`tabindex` of
  `evidence-link`. Everything else in `test/goldens/*.outline.txt` is compared verbatim.

## G. Questions for the owner (each with the default the tests pin)

1. **Graph root role.** Contract says `role="img"`; axe rejects focusable nodes inside it. Default: `role="group"` (D1). Alternative: make
   nodes non-focusable and keep `img`, but then MC10 "follow with the keyboard" has no route to an edge's menu.
2. **`aria-expanded` of a notebook block.** Default: on the `toggle` button (D1). The contract's `block aria-expanded` is invalid ARIA on a plain element.
3. **Unsupported views.** `rankViews` makes them unavailable, so they never become the pane's view. Default: listed in `needs-evidence` with the
   reason and visible as `embedded-view > completeness[data-status=unsupported]` inside a notebook. Alternative: let a `unavailable-view` entry be
   activated to show the strip. The brief's MC4 wording ("completeness data-status unsupported ... no list/data element rendered") is satisfied by the embed.
4. **Layout v1 geometry quirks (red-contract 6), pinned literally in the graph golden.** (a) The bottom route for two vertically adjacent members of one
   SCC (`b`,`c`) draws through both nodes and has a repeated point (`L 336 132 L 336 132`). (b) A self loop reaches `fx+200`, outside the stated `width`
   (`696 > 672`). (c) A self edge in grid layout is a zero-length path. The tests do not pin (c); they pin (a) and (b) because the contract says so.
   Suggest: widen `width` by the loop and route SCC-internal edges beside the nodes in layout/2.
5. **`partial (1 gaps; ...)` grammar** follows the red-contract 3 header literally. A viewer may want `1 gap`; then the three tests that name it change.
6. **`evidence-coverage`** is a new strip element (the contract demands the coverage but names no element). Value = cited source ids.
7. **Graph item actions** live on `graph-edge-item`, not inside the SVG; graph nodes have no menu (Enter opens the entity). Default keeps the SVG free of nested widgets.
8. **Resolved `{viewId,itemId}` link** opens the linked view's entity with that definition selected and the item selected, replacing the trail (reducer `open`).
   A link whose view or item is missing shows `no-target`/`error` inside the claim block and changes nothing else.
9. **Built-in views** (`builtin:metadata`, `builtin:raw`) are tabs; the tests never look inside them.
10. **`aria-selected` on rows/nodes/fields** is the selection state (pane selection `[id]`); clicking selects and opens like Enter (design 8 default 2).
