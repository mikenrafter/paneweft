---
name: paneweft-views
description: Author and maintain permanent typed views and executable examples in a repository.
---

Use this when a recurring development question needs an inspectable answer.
Read the repo instructions and the paneweft manifest. State the question and the type.

1. Call `list_types`, `list_views_for_type` and `list_examples` (CLI: `paneweft types`, `paneweft views`, `paneweft examples`).
   Check freshness, target, features and coverage. Reuse a useful view or example first. A missing result in a stale
   catalogue is not proof that nothing exists. On a fresh repository no catalogue is stored yet: the answer is empty, partial
   and unverified. That is not a reason to stop, and nobody has to build the catalogue for you: the first `collect` exports it.
2. For a new view, call `scaffold_view`. Apply its patch with your normal code editor. When no catalogue is stored yet, or
   the type is not in it, pass `source` (the path and symbol that declare the type); the compiler validates that candidate.
   Put typed computation beside the owning code or in a sibling dev module. Add the registration and a focused example. Do
   not guess field names.
3. Write an output test with a WHY and a CLAIM id. Use independently expected values. Run it red (a failing assertion, not a
   compile error) before implementing the projection. Follow build-loop gates when that workflow is active.
4. Implement over real values. Select fields deliberately. Preserve object targets, partial states and evidence. Keep hooks out
   of release builds.
5. Call `collect` with a registered adapter and the exact example ids. The collection exports the catalogue itself, resolves
   your ids against what it exported (so an example you just wrote needs no extra step), runs those examples, and stores the
   catalogue it exported once it succeeds. An id that no export declares fails the job and names the nearest declared ids.
   Follow the job with `collection_status` until it is terminal. Use `explain_failure` for named diagnostics.
   `cancel_collection` stops a job.
6. Call `view_result`. Inspect the text and, when a browser is available, the rendering. Test facts, navigation, empty and error
   states and the relevant limits. A browser link alone is not evidence that the rendering was checked.
7. Update the view inventory and docs, run the repository's required checks, and retain declarations and tests. Report commands,
   run and snapshot ids, stale gaps, renderer trust needs and any visual check that could not run.

Command recipe (all commands take `--format json|text` and `--max-bytes`):

```sh
paneweft types --repo vigil
paneweft views --repo vigil --type vigil::watch::WatchFile
paneweft examples --repo vigil --type vigil::watch::WatchFile
paneweft scaffold view --repo vigil --type vigil::watch::WatchFile --question "Which events survive a cancel?"
paneweft collect --request-id r1 --repo vigil --adapter cargo --example watch.cancelled
paneweft collection status r1
paneweft result --run run-r1 --view watch.events
paneweft failure diag-inv-1
```

Registering an adapter (`paneweft adapter add`) and trusting a renderer digest (`paneweft renderers trust`) are owner decisions
made on the command line; there is no tool for them. An owner may also rebuild the stored catalogue ahead of time with
`paneweft catalogue refresh`; an agent never needs it.

Use the JSON fallback for an unsupported language, a read-only codebase, an external historical artifact, a cross-repo narrative,
or a one-off question that does not justify permanent instrumentation. Name that reason and use
list_components -> describe_component -> validate -> render. Preserve the actual provenance. Never replace a broken existing SDK
view with hand-written observed results. Repair the view or report its failure.
