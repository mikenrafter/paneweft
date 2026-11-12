---
name: paneweft-views
description: Author and maintain permanent typed views and executable examples in a repository.
---

Use this when a recurring development question needs an inspectable answer.
Read the repo instructions, then check what paneweft wiring the repository already has. Rust: a `paneweft` cargo feature, `vendor/paneweft`,
`#[paneweft::views]` impls. TypeScript: `@paneweft/sdk` in `package.json`, a `paneweft.views.ts` manifest, the reporter in the vitest config. A
repository with none of it gets it in step 2; there is nothing to read first. State the question and the type.

1. Call `list_types`, `list_views_for_type` and `list_examples` (CLI: `paneweft types`, `paneweft views`, `paneweft examples`).
   Check freshness, target, features and coverage. Reuse a useful view or example first. A missing result in a stale
   catalogue is not proof that nothing exists. On a fresh repository no catalogue is stored yet: the answer is empty, partial
   and unverified. That is not a reason to stop, and nobody has to build the catalogue for you: the first `collect` exports it.
   A custom view shows the renderer it needs and its trust state there (`renderer=...`, with the exact command the owner runs).
2. For a new view, call `scaffold_view`. It reads the repository and returns everything that applies as given: the patches (the view;
   Cargo.toml or the `paneweft.views.ts` manifest when missing), the `setup` steps (the SDK copy or install command for this
   checkout, the reporter line for the vitest config), the output test and the registration step. Apply the patches with your normal
   code editor and run the setup commands. When no catalogue is stored yet, or the type is not in it, pass `source` (the path and
   symbol that declare the type; `--args` carries it); the compiler validates that candidate. Put typed computation beside the
   owning code or in a sibling dev module. Do not guess field names. A new example comes from `scaffold_example`.
3. Make the output test red before implementing the projection. The scaffold's test builds the view in memory: fill `sample()` with a
   value built by the real constructor, run the test, and see it fail on the assertion that the view is `complete` (an unsupported
   view has no data to read, so assert that state first and a missing field never surfaces as a TypeError). Then write independently
   expected values with a WHY and a CLAIM id. Run it red (a failing assertion, not a compile error) first. Follow build-loop gates
   when that workflow is active.
4. Implement over real values. Select fields deliberately. Preserve object targets, partial states and evidence. Keep hooks out of
   release builds, and check that they are: a release build must not mention the SDK (commands in the recipes below). In a Rust crate
   the SDK is an optional path dependency on a copy INSIDE the repository: a path outside it breaks every plain build where the paneweft
   checkout is absent, because Cargo reads optional path dependencies even when the feature is off.
5. Call `collect` with a registered adapter and the exact example ids. The collection exports the catalogue itself, resolves
   your ids against what it exported (so an example you just wrote needs no extra step), runs those examples, and stores the
   catalogue it exported once it succeeds. An id that no export declares fails the job and names the nearest declared ids. The job
   advances by itself (a detached driver follows it), so you do not have to poll; `collection_status` reports it, and
   `--wait-seconds N` (at most 30) waits up to N seconds for it to change; repeat until the state is terminal. Use `explain_failure` for named diagnostics. `cancel_collection` stops a job.
6. Call `view_result`. With two or more examples in the run name one: `--example <id>` picks the example's own result, `--observation`
   an object. Read the header's example line (a view captured by a failed example says so). Test facts, navigation, empty and error
   states and the relevant limits. To inspect the rendering run `paneweft serve` and open the printed URL (it needs the viewer built:
   `npm run build:viewer`); the pane shows the view's question, the rows as a grid and keyboard navigation. A browser link alone is not
   evidence that the rendering was checked; say when no browser ran.
7. Update the view inventory and the docs, run the repository's required checks, and retain declarations and tests. The inventory
   is `paneweft.inventory.json` at the adapter root; `paneweft inventory update --repo R --adapter A` writes it from the stored
   catalogue, so run it AFTER the first successful collect of the new id (it adds; a declared id the catalogue lacks stays unless
   `--prune`), and review the diff. A `collect` runs without it and its replies report the unlisted ids; the owner's catalogue check
   and CI fail on them. Report commands, run and snapshot ids, stale gaps, renderer trust needs (the state and command `paneweft views`
   and `paneweft result` print) and any visual check that could not run.
8. A diagnostic id is `run-<job>:diag-...`; use the id exactly as `collection_status` prints it (a bare `diag-...` works only when one
   run holds it). Categories: `assertion` (a failed check, with the example and the source line of the check), `runner` (the runner could
   not start or crashed; the next action names the adapter field), `compiler`, `typecheck`, `registration`, `renderer`.

Command recipe (all commands take `--format json|text` and `--max-bytes`):

```sh
paneweft types --repo vigil
paneweft views --repo vigil --type vigil::watch::WatchFile
paneweft examples --repo vigil --type vigil::watch::WatchFile
paneweft scaffold view --repo vigil --type vigil::watch::WatchFile --question "Which events survive a cancel?"
paneweft collect --request-id r1 --repo vigil --adapter cargo --example watch.cancelled
paneweft collection status r1 --wait-seconds 30
paneweft result --run run-r1 --view watch.events --example watch.cancelled
paneweft failure run-r1:diag-inv-1
paneweft inventory update --repo vigil --adapter cargo
paneweft serve
```

Registering an adapter (`paneweft adapter add`, format in the README's v1 section; for vitest the executable is `node`) and trusting a renderer
digest (`paneweft renderers trust`) are owner decisions made on the command line; there is no tool for them. An owner may also rebuild the
stored catalogue ahead of time with `paneweft catalogue refresh`; an agent never needs it. A renderer that was edited since a value was captured
says `changed`: collect the example again (`docs/renderers.md`).

Rust recipe (the scaffold prints these for your type; everything stays behind the feature):

```sh
node <paneweft checkout>/scripts/vendor-rust-sdk.mjs vendor/paneweft        # in the crate root; again to update
cargo tree -i paneweft                                                      # release check: "did not match any packages"
strings target/release/<artifact> | grep -c -i paneweft                     # 0 with the feature off (nonzero with it: the control)
```

```toml
[features]
paneweft = ["dep:paneweft"]
[dependencies.paneweft]
path = "vendor/paneweft/paneweft"
optional = true
```

```rust
#[cfg(feature = "paneweft")]
#[paneweft::views(type_id = "vigil::watch::WatchFile")]
impl WatchFile {
    #[paneweft::view(id = "watch.status", title = "Status", component = "shape", priority = 10, question = "What state did this watch reach?")]
    fn status_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
        let mut details = cx.details();
        details.field("status", format!("{:?}", self.status));
        details.finish()
    }
}
#[cfg(all(test, feature = "paneweft"))]
mod paneweft_examples { // never a second `mod tests`: that is error E0428
    use super::*;
    paneweft::test_adapter!(); // once per test binary
    #[paneweft::example(id = "watch.pending", claims = ["VW1"])]
    fn watch_pending() -> WatchFile { let w = WatchFile::pending(); paneweft::check_eq!("VW1", w.status, WatchStatus::Pending); w }
}
// the output test builds the view in memory:
//   let mut capture = paneweft::Capture::new(paneweft::CaptureOptions::default());
//   capture.publish(&value).expect("publishes");  let graph = capture.finish().to_json();   // graph["views"][i]["viewId"], ["completeness"]["status"], ["data"]
```

TypeScript recipe (the scaffold prints the manifest, the install line and the reporter line when they are missing):

```sh
npm install --save-dev @paneweft/sdk@file:<paneweft checkout>/packages/paneweft-ts
# vitest config:  test: { reporters: ["default", "@paneweft/sdk/vitest-reporter"] }
grep -li paneweft <the production bundles>                                  # release check: no output
```

```ts
// src/x.paneweft.ts (development only)      export const T = defineType<X>({ id: "repo::X", source: { path: "src/x.ts", symbol: "X" } });
//                                           export const xView = T.view({ id, title, question, priority, component: "shape", render: (x, view) => view.details().field("a", x.a).done() });
// tests/x.examples.ts                       export const ex = example({ id: "x.one", type: T, claims: ["C1"], run(cx) { const x = build(); cx.check("C1", () => expect(x.a).toBe(1)); return x; } });
// tests/x.paneweft.test.ts                  exampleTest(ex);        // from "@paneweft/sdk/vitest"
// paneweft.views.ts                         export const manifest = defineManifest({ runners: ["vitest"], modules: [{ path: "src/x.paneweft.ts", types: [T], views: [xView] }, { path: "tests/x.examples.ts", examples: [ex] }] });
// the output test: new Capture().publish(sample, T); capture.finish().toJSON().views[i].completeness
```

Use the JSON fallback for an unsupported language, a read-only codebase, an external historical artifact, a cross-repo narrative,
or a one-off question that does not justify permanent instrumentation. Name that reason and use
list_components -> describe_component -> validate -> render. Preserve the actual provenance. Never replace a broken existing SDK
view with hand-written observed results. Repair the view or report its failure.
