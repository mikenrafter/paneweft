# paneweft

Portable moldable-development views: a catalogue of visualization components that coding agents fill with facts about any codebase, rendered in a local browser viewer and returned to agents as bounded text over MCP and CLI. Derived from Glamorous Toolkit. Design: docs/design.md.

## Why "paneweft"

The name joins two words, one from screens and one from weaving.

**Pane.** A pane is one framed section of a window, like a single pane of glass. In paneweft's viewer, each pane shows one view of one object: a list of a watch's events, say, or the details of one bookmark mapping. Opening a row opens another pane beside it, so you move through the code's data one pane at a time.

**Weft.** Cloth on a loom is made from two sets of threads. The warp threads run lengthwise and are stretched tight on the loom before weaving starts; they stay fixed. The weft is the thread the weaver passes crosswise, over and under the warp, row after row. Neither set alone is cloth. The pattern you see comes from how the weft crosses the warp.

**Together.** Here the code is the warp: it is there first and it holds the structure. The views are the weft: they are threaded through the code, crossing it at the places worth seeing, and they are what make its shape visible. Since v1, views and their examples live inside the code they explain, so they are woven in rather than laid on top. When the code changes, views that no longer fit show up as stale, the way a dropped thread shows in cloth.

## Requirements

* Node.js >= 22.18. The CLI and the MCP server are TypeScript run directly by Node's built-in type stripping (unflagged from 22.18); there is no compile step and no `tsx` at run time. Older Node versions fail on the first import.
* Linux with **util-linux `flock(1)` on `PATH`**. Every write to a session directory (imports, view registration, notebook updates, recorded runs) takes a kernel file lock through that program, so two processes can never update the same session at once. The kernel releases the lock when the writer and its `flock` helper have both exited. A helper that is stopped (for example by SIGSTOP) after acquiring keeps the shared descriptor; if its parent is then killed, the whole session stays locked until that helper is killed, and other writers time out with `CONFLICT`. v0 has no watchdog for this. Without it every write fails with `STORAGE_FAILED` (`details.cause: "flock-missing"`, message naming util-linux); reading a session needs nothing. util-linux is part of every mainstream Linux distribution (Debian and Ubuntu: package `util-linux`, installed by default; Alpine: `apk add util-linux`; NixOS: `pkgs.util-linux`). macOS and Windows do not ship it.

## Usage

### Install

```sh
git clone <this repository> paneweft && cd paneweft
npm install
npm run build:viewer   # bundles the browser viewer into dist/viewer (dist/ is gitignored); needed before `serve`
```

Nothing else is built: the CLI and MCP server run from `src/`. `npm run check` runs the type check and the test suite; the tests need util-linux `flock` (see Requirements).

### Run the CLI

The entry point is a TypeScript file that Node runs itself:

```sh
node src/cli/bin.ts --help
```

The examples below write `paneweft` for that command. Define it once per shell (or `npm link` the repository, which installs a `paneweft` executable):

```sh
alias paneweft='node /path/to/paneweft/src/cli/bin.ts'
```

Everything is stored in a **session directory**, chosen with `--session DIR` or the `PANEWEFT_SESSION` environment variable. The directory is created when it is first written. A session holds the registered entities and view definitions, every stored view snapshot (immutable, content-addressed) and notebook revisions; copy or delete the directory to move or discard it.

Output: stdout carries the reply body (also for operation errors), stderr carries usage errors. Exit code 0 is success, 1 an operation error (the body is a `paneweft.error/1` JSON document with a code, a JSON pointer, the violated constraint and a repair hint), 2 a usage error. Every operation command takes `--format text|json` (default `text`), and accepts the tool's arguments verbatim as `--args '<json>'` or `--args-file FILE` (`-` reads stdin), so a CLI call and an MCP call can use the same request bytes.

### Agent workflow

An agent fills views with facts it has read, parsed, observed or inferred, and the tool checks and summarises them. The loop:

1. **`components`**: the seven components (`list`, `tree`, `graph`, `source`, `shape`, `notebook`, `example`) and the question each answers. Pick the one that matches the question being asked.
2. **`describe NAME`** (`describe graph`; `--component NAME` is the same): the component's JSON Schema, limits and one valid example. Copy the example and replace its facts.
3. **`validate --file FILE`**: checks an envelope (`paneweft.view/1`) or a bundle (`paneweft.bundle/1`: entities, view definitions and views together) without storing anything. A failure lists every problem with its pointer and a hint. Given a session that exists (`--session DIR`, or over MCP), it also makes the decision `render` would: definitions, entities and views already stored there can refuse the input (`IDENTITY_CONFLICT`, `SNAPSHOT_CONFLICT`), and the reply says `identity: session`. Without a session only the document is checked and the reply says `identity: none`; that is not a promise that `render` will accept it.
4. **`render --file FILE`**: validates again, stores the snapshot atomically and returns a bounded summary plus the viewer URL (when a viewer is running for the session). Stored views are immutable: change a view by submitting it under a new snapshot id.
5. **`inspect`, `open`, `navigate`**: read it back. `inspect` returns a slice of one stored view (filter, order, focus). `open` shows an entity at a snapshot with the views that apply to it. `navigate` follows an item of a pane to its target (another entity, or the source lines behind it with `action: "open-source"`). `search` finds entities, view titles, examples and notebook claims.

Try the whole loop against the committed fixtures (run from the repository root):

```sh try
export PANEWEFT_SESSION="$PWD/.session"
paneweft components
paneweft describe list
paneweft validate --file fixtures/components/all.bundle.json
paneweft render --file fixtures/components/all.bundle.json
paneweft inspect --view modules --snapshot snap-1
paneweft open --args '{"snapshotId":"snap-1","entity":{"repository":"r","kind":"vigil/watch","id":"watch"}}'
paneweft navigate --args '{"pane":{"entity":{"repository":"r","kind":"vigil/watch","id":"watch"},"snapshotId":"snap-1","viewDefinitionId":"def-modules","selection":[],"filters":{},"pinned":false},"itemId":"mcp"}'
paneweft search --query cancellation
```

(`.session/` is gitignored.) `open` returns the `pane` object that `navigate` takes back; with `--format json` it is a field of the reply.

**Budgets and cursors.** Every reply fits the byte budget in `--max-bytes` (`maxBytes` over MCP): default 8192, at least 2048, at most 32768. A budget below 2048 is `BUDGET_TOO_SMALL` (the error says the minimum), above 32768 is `INVALID_ARGUMENT`. The reply always begins with a header (question, completeness, freshness, snapshot, provenance counts, how many items matched and how many were returned) so a clipped reply says what it left out. When more content exists the reply ends with `cursor: <token>` (`"cursor"` in JSON). Pass that token back with the **same** request to get the next page:

```sh
paneweft inspect --view modules --snapshot snap-1 --max-bytes 2048
paneweft inspect --view modules --snapshot snap-1 --max-bytes 2048 --cursor '<token from the previous reply>'
```

A cursor is bound to the view, snapshot, filter and order that issued it and to the content it paged (`CURSOR_MISMATCH` for another query, `CURSOR_STALE` when the listing changed, `CURSOR_INVALID` when it was altered); drop it to start again. The last page has no cursor.

### Revise a view

A view is stored per `(view id, snapshot id)` and never changes; a definition (`viewDefinitionId`) has one content for the whole session. So a revision is a **new snapshot id** for the facts, and the definition ids depend on what changed:

* **The facts changed** (the code moved, a field is now present, you read more of it): submit the views again under a **new snapshot id** and **reuse** the same definition ids unchanged. Entities are restated under the new snapshot (an entity is unique per snapshot). The registry does not move. Resubmitting a view id under an old snapshot with other content is `SNAPSHOT_CONFLICT`.
* **The definition's own content changed, same component and entity kind** (title, priority, `requires`, `dataRole`): an import that carries the new content under the old definition id is `SNAPSHOT_CONFLICT`. Change it with `register` and the current registry revision (`register --file DEFINITION.json --expected-revision N`); it replaces the definition for every snapshot.
* **What the definition is changed** (another component or entity kind): **version the id**: `def-messages` becomes `def-messages-v2`, and new views use the new id. Redefining the old id in place is `IDENTITY_CONFLICT`, because views already stored under it keep their component; those old views and their id stay valid.

`validate --session DIR` makes this decision before `render` does (see the workflow above), so a conflict shows up as an error with a pointer instead of a failed render.

### Schemas

The wire contracts are JSON Schemas in `src/schemas/` (not at the repository root). `describe NAME` prints one component's schema with its limits and a valid example, which is usually all an author needs. The files: `src/schemas/envelope.schema.json` (a view, `paneweft.view/1`), `bundle.schema.json` (entities, definitions and views together, `paneweft.bundle/1`), `entity.schema.json`, `definition.schema.json`, `common.schema.json` (shared items, ids, provenance), `src/schemas/components/<component>.schema.json` (the `data` of each component), `src/schemas/tools/<tool>.schema.json` (each tool's arguments, which MCP advertises), and `reply.schema.json` and `error.schema.json` (the JSON reply and error bodies).

### Use it from an MCP client

`paneweft mcp` serves the same operations as tools over stdio (thirteen tools: `list_components`, `describe_component`, `validate`, `register_view`, `render`, `open_entity`, `navigate`, `inspect_view`, `search`, `notebook_create`, `notebook_get`, `notebook_update`, `example_record`). Register it with any MCP client that launches a stdio server. Use absolute paths; the client does not run from the repository:

```json mcp-config
{
  "mcpServers": {
    "paneweft": {
      "command": "node",
      "args": ["/path/to/paneweft/src/cli/bin.ts", "--session", "/path/to/session", "mcp"]
    }
  }
}
```

`node` must be version 22.18 or later. The server tells the client the workflow and how cursors page (the MCP `instructions` string); each result is one text block within `maxBytes`. Without a session directory, the tools that need one answer `SESSION_REQUIRED`. Running a scenario (`example run`), registering repository roots and serving the viewer are CLI-only on purpose: no tool call can start a process or name a directory to trust.

### Register repository roots

Views cite files of a repository (`repository` ids such as `r`). Whether those files still match what the view recorded is checked against the repository's **root on this machine**, which the session owner registers; until then the reply says `freshness: unverified (... register its root ...)`. Register it with the CLI (not available over MCP):

```sh try
paneweft repo add r=.
paneweft repo list
```

`repo add ID=ROOT` stores the absolute path (a relative ROOT is resolved against the current directory; adding an id again replaces its root). Files are only read inside a registered root, through a verified handle, so a symlink cannot lead out of it. The check happens when a view is read, so roots can be registered before or after `render`. `serve --repo ID=ROOT` registers a root and starts the viewer in one step.

### View in the browser

```sh
paneweft serve            # prints http://127.0.0.1:PORT/#token=...
```

The viewer binds loopback only and every API call needs the per-run token in that URL; the URL is also written to `server.json` in the session directory (mode 0600) so `render` can print a link while a viewer runs. Stop it with Ctrl-C. If the page is blank, run `npm run build:viewer` first. The page keeps its token in memory only (it removes it from the address bar as it loads), so **reloading the page drops access**: reopen the URL printed by `serve` or `render`.

## v1: views and examples that live in the code

v1 captures REAL values. A repository declares typed views and runnable examples beside the code (Rust crate or TypeScript/Vitest package); `paneweft collect` runs the
examples through `qex` (a queue wrapper that must be on `PATH`; tested with 0.33.0), stores what they built as ordinary views, and the CLI, the MCP
tools and the viewer read them back. The agent loop is `skills/paneweft-views/SKILL.md`; normative rules are `docs/v1-red-contract.md`. This section is what the owner
of a repository does once. All commands below take `--session DIR` (or `PANEWEFT_SESSION`); `paneweft` is the alias from "Run the CLI".

### 1. Register the repository and an adapter (owner, CLI only)

```sh
paneweft repo add vigil=/path/to/repository            # the root the renderers, freshness and the inventory are read from
paneweft adapter add --file adapter.json               # one record per (repository, runner); paneweft adapter list shows them
```

The record is `paneweft.adapter/1`, written by the owner. No tool and no agent can create or change one.

```json
{ "schemaVersion": "paneweft.adapter/1", "id": "cargo", "kind": "cargo", "grammar": "cargo-test/1", "repo": "vigil",
  "executable": "/usr/local/cargo/bin/cargo", "workspaceRoot": "/path/to/phoe-nix/scout-modules/vigil", "entry": ".",
  "features": ["paneweft"], "supportedVersions": ["1.97"],
  "env": { "set": { "RUSTUP_HOME": "/usr/local/rustup", "CARGO_HOME": "/usr/local/cargo" } },
  "limits": { "timeoutMs": 900000, "logBytes": 1048576 }, "queue": { "wrapper": "qex", "cpu": "4", "mem": "6GB", "tags": ["paneweft"] } }
```

```json
{ "schemaVersion": "paneweft.adapter/1", "id": "vitest", "kind": "vitest", "grammar": "vitest-run/1", "repo": "containmarks",
  "executable": "/path/to/node", "workspaceRoot": "/path/to/containmarks", "entry": ".",
  "tsconfig": "tsconfig.paneweft.json", "vitestConfig": "vitest.config.ts",
  "features": [], "supportedVersions": ["3.2"],
  "limits": { "timeoutMs": 600000, "logBytes": 1048576 }, "queue": { "wrapper": "qex", "cpu": "2", "mem": "2GB", "tags": ["paneweft"] } }
```

| Field | Meaning |
|---|---|
| `id`, `repo` | the adapter's name (`--adapter`) and the repository it belongs to (`--repo`) |
| `kind`, `grammar` | `cargo` + `cargo-test/1`, or `vitest` + `vitest-run/1`: the argv shape is code, selectors are data |
| `executable` | an ABSOLUTE path to an executable file (`adapter add` checks). **For `vitest` it is `node`**: the host runs its own `scripts/collect-vitest.mjs` (typecheck, then Vitest) with it, not the `vitest` binary. For `cargo` it is `cargo`; a rustup proxy needs `RUSTUP_HOME` (and `CARGO_HOME`), see `env` |
| `workspaceRoot`, `entry` | where the runner starts: the directory of `Cargo.toml` (cargo) or `package.json` (vitest) is `workspaceRoot/entry` |
| `features` | cargo features passed as `--features` (include `paneweft`); `[]` for vitest |
| `supportedVersions` | the runner versions you tested; used as the label when a runner reports none, and not checked against the installed one. `executableSha256` (optional) is recorded and not checked either |
| `tsconfig`, `vitestConfig` | vitest only: the tsconfig the collection typechecks against, and the Vitest config it runs, both relative to the package directory, no `..`, existing files. Point `tsconfig` at one that `extends` the repository's and lists only what the instrumentation imports, so an unrelated type error (a script, a live test) cannot block every collect |
| `env` | pins the job environment: a job gets qex's minimal environment, then the `passthrough` names (and a default list: `RUSTUP_HOME CARGO_HOME RUSTUP_TOOLCHAIN CARGO_TARGET_DIR TMPDIR LC_ALL TERM SSL_CERT_FILE SSL_CERT_DIR`) the submitting process has, then `set`, which wins. A CLI call and an MCP server started by a client with a bare environment run the same job for every name in `set`. `PANEWEFT_*` is refused. A job that qex could not start is reported as a `runner` diagnostic naming this field |
| `limits`, `queue` | job timeout and log bytes kept; the qex resources (`--cpu`, `--mem`) and tags. `limitCeilings` (optional) caps the capture bounds a request may ask for |

### 2. Instrument a Rust crate

The SDK is an optional development dependency behind a `paneweft` feature, taken from this public repository at a pinned commit:

```toml
[features]
paneweft = ["dep:paneweft"]

[dependencies.paneweft]
git = "https://github.com/mikenrafter/paneweft"
rev = "cb01e0e9f7f71b413a00e8851d852b70f37d4dad"
optional = true
```

Why a git dependency: Cargo reads the manifest of every path dependency, optional ones too, so a path to a checkout next to the repository breaks every plain `cargo build` and
Nix build where that checkout is absent. A git dependency resolves on any machine that can reach GitHub: run `cargo fetch` once (even with the feature off, Cargo needs the source to
resolve the lock) and every later build can be `--offline`. The release build leaves the feature off and links none of the SDK.

Rev policy: always a full commit, never a branch. It is the commit this checkout's scaffolds print (`paneweft scaffold view|example`), and `src/v1/sdk-source.test.ts` fails
when `crates/` here differs from it. To bump an instrumented repository: set `rev` to the new commit and run `cargo update -p paneweft --precise <commit>`. For an offline
machine use `cargo vendor` (it carries git dependencies). A Nix build of the crate (`rustPlatform.buildRustPackage`) gives the git source a hash: `cargoLock.outputHashes."paneweft-0.0.0" = "sha256-..."`
(leave it empty once, copy the hash Nix prints), see `docs/v1-red-contract.md` section 1a. Then, behind
`#[cfg(feature = "paneweft")]`, a views impl and an example (compact recipe; `paneweft scaffold view|example` prints these for your type and applies cleanly):

```rust
#[cfg(feature = "paneweft")]
#[paneweft::views(type_id = "vigil::watch::WatchFile")]
impl WatchFile {
    #[paneweft::view(id = "watch.status", title = "Status", component = "shape", priority = 10, question = "What state did this watch reach?")]
    fn status_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
        let mut details = cx.details();
        details.field("status", format!("{:?}", self.status));
        details.field("event count", self.events.len());
        details.finish()
    }
}

#[cfg(all(test, feature = "paneweft"))]
mod paneweft_examples {
    use super::*;
    paneweft::test_adapter!();   // once per test binary: the reserved catalogue-export test

    #[paneweft::example(id = "watch.pending", claims = ["VW1"])]
    fn watch_pending() -> WatchFile {
        let watch = WatchFile::pending();
        paneweft::check_eq!("VW1", watch.status, WatchStatus::Pending);
        watch
    }
}
```

### 3. Instrument a TypeScript / Vitest package

```sh
npm install --save-dev @paneweft/sdk@file:/path/to/paneweft/packages/paneweft-ts      # not published; a development dependency only
```

Wire the reporter in the Vitest config the adapter names (it finalizes each example's outcome after its hooks; the entry loads in Vitest's main process, which the
main entry cannot): `test: { reporters: ["default", "@paneweft/sdk/vitest-reporter"] }`. Then a type token, a view, an example, the explicit manifest and a test file that runs the example:

```ts
// src/mappings/containerMappings.paneweft.ts   (development only: never import it from a production entry point)
import { defineType } from "@paneweft/sdk";
export const Mapping = defineType<ContainerMappingRecord>({ id: "containmarks::ContainerMappingRecord", source: { path: "src/models.ts", symbol: "ContainerMappingRecord" } });
export const mappingDetails = Mapping.view({ id: "mapping.details", title: "Container mapping", question: "Which original index and container does this mapping preserve?",
  priority: 10, component: "shape", render: (mapping, view) => view.details().field("original index", mapping.firstSeenIndex).field("backup name", mapping.backupName).done() });

// tests/mappings.examples.ts
import { example } from "@paneweft/sdk";
export const workMapping = example({ id: "mapping.work", type: Mapping, claims: ["CM1"], run(cx) {
  const mapping = parseContainerMappingUrl("about:4:firefox-container-3:Work");
  cx.check("CM1", () => expect(mapping).toEqual({ firstSeenIndex: 4, cookieStoreId: "firefox-container-3", backupName: "Work" }));
  return mapping!;
} });

// tests/mappings.paneweft.test.ts        runs the example under Vitest
import { exampleTest } from "@paneweft/sdk/vitest";
exampleTest(workMapping);

// paneweft.views.ts                      the manifest: modules are listed, never discovered
import { defineManifest } from "@paneweft/sdk";
export const manifest = defineManifest({ runners: ["vitest"], modules: [
  { path: "src/mappings/containerMappings.paneweft.ts", types: [Mapping], views: [mappingDetails] },
  { path: "tests/mappings.examples.ts", examples: [workMapping] },
] });
```

The SDK's `.ts` sources run under Node and Vitest; its package ships declarations, so a strict consumer typechecks without `allowImportingTsExtensions`. An example module may
`import { expect } from "vitest"` at the top: the catalogue export replaces `vitest` with an inert module and never runs an example body.

### 4. Collect and read

```sh
paneweft collect --request-id r1 --repo vigil --adapter cargo --example watch.pending     # exports the catalogue itself, runs the example, imports the run
paneweft collection status r1                  # the job advances by itself (a detached driver follows it); status only reports
paneweft result --run run-r1 --view watch.status --example watch.pending
paneweft failure run-r1:diag-inv-1             # explain a diagnostic
paneweft serve                                 # the viewer: the question, the status strip, the rows, keyboard navigation
```

### 5. The inventory file

`paneweft.inventory.json` sits at the adapter root (`workspaceRoot/entry`), is checked in, and guards against losing a view or an example:

```json
{ "schemaVersion": "paneweft.inventory/1",
  "views": [ { "id": "watch.status", "module": "watch::paneweft_views" } ],
  "examples": [ { "id": "watch.pending", "module": "watch::paneweft_examples", "typeId": "vigil::watch::WatchFile" } ] }
```

`module` is what the compiled catalogue names: the crate-relative module path for Rust, the repository-relative file path for TypeScript; entries are sorted by id. After a
collect has stored the catalogue, `paneweft inventory update --repo vigil --adapter cargo` writes the file from it: it adds new ids, keeps declared ids the catalogue lacks (and says
so; `--prune` drops them), and keeps the file's indentation and one-entry-per-line shape, so review is one added line. A `collect` is not blocked by an id the file does not list yet
(discovery replies carry a notice naming it); `paneweft catalogue refresh` and CI are the strict check.

### 6. Release builds must not contain the SDK: how to check

Rust (feature off; replace `libplain.rlib` with the binary or library your release produces):

```sh
cargo build --release
cargo tree -i paneweft          # error: package ID specification `paneweft` did not match any packages   (the SDK is not in the build graph)
strings target/release/libplain.rlib | grep -c -i paneweft         # 0
strings target/release/libplain.rlib | grep -c linkme              # 0
cargo build --release --features paneweft && strings target/release/libplain.rlib | grep -c -i paneweft     # 34: the positive control
```

(A directory or crate named after paneweft puts the word into debug paths, so a nonzero count proves nothing until the control is compared.) TypeScript: build the production bundles
and search them; the SDK is only ever reached from the manifest, the `*.paneweft.ts` modules and the tests:

```sh
npm run build && grep -li paneweft src/background.js src/preferences/options.js src/picker/picker.js     # no output: no bundle mentions it
```

### 7. Custom renderers

`renderers/<id>/` of the registered root, trust by digest, `paneweft renderers digest|list|trust`, the page and the message protocol: `docs/renderers.md`.

## License

MIT. See LICENSE.
