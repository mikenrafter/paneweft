# Viewer DOM contract

Normative for `mountViewer` (plain DOM + SVG). Tests select and outline **only** elements carrying a
`data-pw` attribute (`test/helpers/structure.ts`), so everything else in the markup is free. Attributes
listed per element are the ones goldens may pin (`OUTLINE_ATTRIBUTES` in the helper). All text is set via
`textContent`/attributes, never `innerHTML`, except sanitised Markdown from `renderMarkdown`.

Viewport and locale come from `MountOptions`; the layout version string is exposed as
`data-layout-version`. No timers, animations or randomness affect the structure.

## Shell

| `data-pw` | Element and attributes |
|---|---|
| `viewer` | root of the mounted app |
| `pane-trail` | `<nav aria-label="Pane trail">` with one `crumb` per trail pane |
| `crumb` | `<button>`; `data-pane-index`; `aria-current="page"` on the active pane |
| `pane` | `<section aria-label="<entity label>">`; `data-pane-index`, `data-entity-id`, `data-snapshot-id`, `data-view-id` (view definition id), `data-pinned` (`true`/`false`) |
| `pin` | `<button aria-pressed>` in the pane header |
| `view-tabs` | `role="tablist"`, `aria-label="Views"` |
| `tab` | `role="tab"`; `aria-selected`, `aria-controls` (a `tabpanel` id), `data-definition-id`, roving `tabindex` (`0` selected, `-1` others) |
| `needs-evidence` | collapsed `<details>` listing registered but unavailable views |
| `unavailable-view` | one entry; text states the missing roles or the reason |
| `tabpanel` | `role="tabpanel"`, labelled by its tab |
| `status-strip` | persistent strip above the view; contains the four below |
| `completeness` | `data-status` (`complete`/`partial`/`unsupported`); visible text: status word plus criterion, first gap, or reason |
| `freshness` | `data-status` (`fresh`/`stale`/`unknown`); text names changed paths or inaccessible roots |
| `snapshot` | text = snapshot id |
| `provenance-summary` | text lists all five categories with counts for the whole view |
| `filter-input` | `<input type="search" aria-label="Filter">`; typing filters (text filter of design 4) |
| `match-count` | `data-matched`, `data-total`; text `M of T match` |
| `empty-state` | visible message: `0 items within this scope` for a complete empty view; for a partial empty view a different message that names the gaps; `no items match the current filters (0 of T)` when filtered empty |
| `error` | `role="alert"`; `data-code`; text = code and message |

## Facts (all components)

| `data-pw` | Element and attributes |
|---|---|
| `fact` | any item representation; `data-id`; `data-provenance` |
| `provenance-badge` | inside every `fact`; `data-provenance`; text = the provenance word (never colour alone) |
| `evidence-link` | one per evidence source id; `data-source`; text = the id |
| `inferred-reason` | for inferred facts: text = `reason`; |
| `actions-button` | `aria-haspopup="menu"`, `aria-expanded` |
| `actions-menu` | `role="menu"`; Escape closes it and focus returns to its `actions-button` |
| `menu-item` | `role="menuitem"`; `data-kind`: `open-entity`, `open-source`, `follow-evidence`, `inspect` |
| `no-target` | shown when an item has no entity/anchor; text says so; activating it creates no pane |

`fact` elements are the same elements as the component-specific ones below where noted (`row`, `node`,
`field`, `graph-node`, `graph-edge`, `block`, `run`): a `row` carries `data-pw="row"`, and contains its
`provenance-badge`/`evidence-link` children; the outline lists `row` and then its children.

## List

`list` (`role="grid"`, `aria-label` = view title) > `column-header` (`role="columnheader"`, `data-id` =
column key, `aria-sort` on the sorted one) and `row` (`role="row"`, `data-id`, `aria-selected`,
`data-provenance`) > `cell` (`role="gridcell"`, `data-id` = column key; text = value). Group headings:
`group` (text = group label). Enter on a focused row opens its entity in the next pane.

## Tree

`tree` (`role="tree"`) > `node` (`role="treeitem"`, `data-id`, `aria-level`, `aria-selected`,
`aria-expanded` only when it has children or is `not_loaded`, `data-children-state`) > `toggle`
(`<button>`; clicking toggles `aria-expanded` and **never** creates a pane) and `cell`. A
`not_loaded` node shows `load-affordance` (text contains `needs evidence`) and is not a leaf. ArrowRight
expands, ArrowLeft collapses, Enter opens the entity.

## Graph

`graph` (`<svg role="img" aria-label=...>`) with `layout-info` (`data-layout`, `data-layout-version`,
width/height as text `W x H`), `graph-node` (`<g>`; `data-id`, `data-x`, `data-y`, `data-group`,
`tabindex`), `graph-edge` (`<g>`; `data-id`, `data-source`... not used; contains `edge-path` with `d`
and `edge-label` with the relation text). Non-colour alternative: `graph-edge-list` (a list of
`graph-edge-item`, `data-id`, text `from -relation-> to`). `relation-filter` lists one checkbox per
relation (`data-id` = relation). Cycles stay visible. Hidden-by-filter edges are absent from the SVG.
Focus mode (`focus` in data) marks `graph-node` with `data-status="focus"` and omits nodes outside the
neighbourhood, with `omitted-neighborhood` text stating how many were omitted.

## Source

`source` > `source-origin` (text: repository, revision or `no revision`, path), `source-line`
(`data-line` = file line number; `data-highlighted` `true`/`false`; text = code only) with
`line-number` (text = number), `annotation` (`<button>`; `data-id`, `data-lines` = `a-b`; text = message
and claim ids), `stale-notice` (when the opening's `currency.state` is `stale`: states the hash mismatch
and that the stored excerpt is shown). Activating an annotation sets `data-highlighted="true"` on its
lines only.

## Shape

`shape` (`data-kind` = basis `declared`/`observed`) > `field` (`role="treeitem"`, `data-id`, `data-path`,
`data-presence`, `aria-level`, `aria-expanded` when it has children) with `field-type` (text), `field-example`
(text; absent example renders `no example`, `null` renders `null`, never conflated) and `field-ref` for
recursive `ref`.

## Notebook

`notebook` > `block` (`data-id`, `data-kind`, `aria-expanded`), `claim-status` (inside claim blocks,
**always visible even when the block is collapsed**; `data-status`; text = status), `claim-filter`
(control over statuses), `embedded-view` (`data-view-id`; collapsed by default; shows the embedded
view's `completeness` strip), `prose` (sanitised Markdown), `evidence-link` per supports/contradicts
target.

## Example

`example` > `scenario` (text = label and runner id), `run` (`data-run-id`, `data-status`) >
`assertion` (`data-passed`, text = statement and PASS/FAIL), `result-link` (entity), `rerun-instruction`
(text names the CLI command `paneweft example run <runnerId>`; the viewer never runs anything),
`not-run` (shown when `runs` is empty; text `not run`).
