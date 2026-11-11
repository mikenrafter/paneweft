# Contract additions: validation (tag: val)

Questions the design and `docs/red-contract.md` leave open for `validateSubmission` and `validateRunOutput`,
each with the default the red tests pin. The owner can overturn any of them; the tests that depend on a default
cite the question number.

## Q1. Does the limit pass short-circuit the schema pass?
`validate.ts` says "limits, then JSON Schema, then semantic checks". Design 7 MC14 says over-limit payloads are
rejected "before storage/rendering". **Default pinned:** if any limit is exceeded the report contains only
`LIMIT_EXCEEDED` issues (all limit breaches, sorted), and neither schema nor semantic issues. Reason: running
the full schema over a hostile document is the cost the limit pass exists to avoid, and a mix of limit and shape
issues buries the one the agent must act on first. Pinned in `limits.test.ts` ("limits are reported before, and
instead of, shape errors").

## Q2. How is nesting depth counted?
**Default pinned:** the submitted document's root container is level 1; every nested array/object adds one; the
cap is 32, so level 32 is accepted and the first container at level 33 is the offender (its pointer is the
`LIMIT_EXCEEDED` pointer). Inside a bundle the count starts at the bundle root (a view member is level 3).
Hostile depth (2,000+) must produce the same issue, not a stack overflow. Pinned in `limits.test.ts`.

## Q3. Which pointer does a count or size limit use?
**Default pinned:** the offending container: `/data/rows`, `/data/nodes`, `/data/edges`, `/data/fields`,
`/data/blocks`, `/data/annotations` for item/graph caps; `""` for the 2 MiB view size of a single envelope and the
8 MiB bundle size; `/views/N` for a bundle member over 2 MiB; the string itself for the 64 KiB string cap.
Item counting is per array (rows, nodes, ...), not a sum over all of a view's arrays; whether the excerpt counts
towards the source view's 10,000 is therefore not tested. The hint of every item/graph/size limit contains
"scope" or "partition" (design 4: "a suggestion to scope or partition the view"); nesting and string hints only
need to be non-empty.

## Q4. What do evidence ids in a `paneweft.run/1` document resolve against?
A run document has no `sources` of its own. **Default pinned:** nothing about this is pinned. The valid run
output fixture in `validate.example.test.ts` cites the file source `s1` of the first view of its own bundle,
with provenance `read`, so it is valid whether the implementation resolves evidence against the bundle's sources
or does not resolve it at all. Proposed rule for the owner: run/assertion `evidence` resolves against the union
of the output bundle's view sources; an `observed` run in an output document is exempt from
`PROVENANCE_RUN_REQUIRED` because the run itself is the observation.

## Q5. `ValidationReport.kind` for a run output
`ValidationReport` is `kind: "envelope" | "bundle" | "unknown"`; a successful `validateRunOutput` has no fitting
value. Tests do not assert `kind` for run outputs. Proposed: add `"run"`. (Stub file not edited.)

## Q6. Classification when `schemaVersion` is wrong or missing
**Default pinned:** a non-object is `TYPE ""` with kind `unknown`; an object without `schemaVersion` is the one
issue `REQUIRED /schemaVersion` (kind `unknown`); a wrong literal is the one issue `SCHEMA_VERSION
/schemaVersion` and nothing else is reported (kind not asserted). Dispatch to the envelope or bundle schema is by
the schemaVersion literal. A bad member `schemaVersion` inside a bundle is addressed `/views/N/schemaVersion`.

## Q7. `DUPLICATE_ID` details
* Namespace order for "later occurrence" is document order of the view's arrays (`nodes` then `edges`, `excerpt`
  then `annotations`, `scenario` then `runs` then each run's `assertions`).
* Pointer for a repeated run id is `/data/runs/N/runId` (the red-contract says "the later occurrence's `id`").
* A `runId` and an item `id` are separate namespaces.
* Not tested (open): duplicate source ids, duplicate link ids, duplicate path ids, and whether a graph path id
  shares the item namespace; duplicate entity or definition identity inside a bundle.

## Q8. Pointers of reference issues not spelled out by the red-contract table
Pinned as "the referring value": `/data/rows/N/cells/<key>` for an unknown column key, `/data/order/key`,
`/data/fields/N/ref`, `/data/fields/N/children/M`, `/data/focus/node`, `/data/paths/N/edgeIds/M`,
`/data/blocks/N/supports/M` and `/contradicts/M` (the whole entry, even when only its `itemId` is bad),
`/definitions/N/forward/viewDefinitionId`, `/views/N/entity`, `/views/N/viewDefinitionId`.
`shape.root` dangling is not tested (open: should it resolve to a field id?).

## Q9. Semantic rules and cascades
* **Single fault, single issue:** an unknown edge inside a path suppresses the continuity check for the edges
  around it; a reversed range suppresses containment (`INVALID_LINE_RANGE` only); a reversed excerpt anchor
  suppresses `ANNOTATION_OUTSIDE_EXCERPT`.
* **Tree cycle:** one `TREE_CYCLE` per cycle, on the `children/N` value that closes it in a depth-first walk from
  the roots in `roots` order (the 3-cycle test closes at the last node's child). A cycle unreachable from any
  root is not tested (open: the default should be to report it too, walking unvisited nodes in array order).
* **Alias cycle:** `ALIAS_CYCLE` on `/definitions/N/forward` for EVERY definition on a cycle (order
  independent), not for a definition that merely leads into a cycle.
* **Entity references in bundles** match on repository + id + kind within the same `snapshotId`; a
  `ReferenceContext` entity of another snapshot does not satisfy a view's `entity`.
* **Mixed shape and semantic faults:** semantic checks run only when the document passed the schema pass; tests
  never mix a shape fault in one member with a semantic fault in another.
* **Single envelope vs bundle:** a notebook `viewId` or `{viewId,itemId}` target naming a view outside the
  envelope is accepted by `validateSubmission` of a single envelope (red-contract: "deferred to render/import")
  and is `DANGLING_REFERENCE` in a bundle. Whether a bare `supports` string is checked against the envelope's own
  source ids in a single envelope is not tested (the contract table lists it as bundle-only).
* **Source anchors:** design 4 says anchors "must resolve to a recorded file hash". There is no issue code for a
  path missing from `freshness.repositories[].files`; not tested. Proposed: `DANGLING_REFERENCE` at the anchor's
  `path`.

## Q10. `compiled` provenance (open, deliberately untested)
Design 2: "`compiled` identifies the compiler or language-service invocation". The schema has no field for it, so
`compiled` is currently accepted exactly like `read`. Proposed default: a `compiled` item must cite at least one
source of kind `command` (a captured compiler/language-service run, `method` naming the tool and version), and
violations get a new issue code `PROVENANCE_COMMAND_REQUIRED` at the item's `provenance`. Until the owner decides,
`validate.provenance.test.ts` only pins that `compiled` needs no run id.

## Q11. Empty and null corner cases not pinned
`constraint` format beyond `type: <type>` for TYPE and the literal for `SCHEMA_VERSION` is not pinned (tests
require non-empty text; TYPE tests require the token "integer" / "object"; enum hints contain the allowed values
because the schema's `x-hint` lists them).
