# v1 red-phase contract

Spec: `phoe-nix/knowledge/research/agentic-practice-2026-11/12-paneweft-v1-in-code-views.md`. Later sections win: "Additions from the
views that teach direction", "Amendments after spec review round 1" (S1-S12) and "Defaults after spec review round 2" (N1-N5).
This file is the **normative interpretation** the v1 red tests pin where the spec leaves a decision open. Every default here is a
proposal the owner can overturn; the red report lists each with the reason. A test that asserts something the spec does not state
cites the section below in its WHY. Machine-readable contracts are the schemas in `src/schemas/v1/` (generated declarations in
`src/generated/v1/`, checked by `npm run gen:types:v1 -- --check`).

Conventions: `CLAIM(IVn)` ids are the spec's section 10; `CLAIM(S5-bounded-builders)`, `CLAIM(N1-two-phase)` etc. name amendments.
Week-one scope is amendment S1; claims outside it are tagged `later` in the report and have no red test.

## 1. Layers and boundaries

| Layer | Where | Boundary the tests use |
|---|---|---|
| Rust SDK | `crates/paneweft`, `crates/paneweft-macros` | `Capture`, `Context`, `Inspectable`, `example::invoke`, `Catalogue` |
| TS SDK | `packages/paneweft-ts` (`@paneweft/sdk`, `@paneweft/sdk/vitest`, `@paneweft/sdk/vitest-reporter`: the reporter alone, which never imports `vitest`) | `Capture`, `defineType`, `runExample`, `compileCatalogue` |
| Wire | `src/schemas/v1/*.schema.json` | raw Ajv (`validateAgainstV1`) |
| Host | `src/v1/*.ts` | the exported functions; `executeV1Operation` for the tools |
| CLI | `src/cli/v1-commands.ts` (table; wiring is green) | `paneweft <words>` as a process |
| MCP | `src/mcp/server.ts` (wiring is green) | `paneweft mcp` over stdio |

### 1a. The Rust SDK dependency (F3)

A crate with in-crate views and examples declares the SDK as an optional dependency behind a `paneweft` feature. Cargo reads the manifest of every path dependency, optional ones included, whenever it
resolves a package, so a path that leaves the repository (`../../paneweft/crates/paneweft`) makes `cargo build`, `cargo metadata` and a Nix build fail wherever that checkout is absent, with the
feature off. The recipe therefore takes the SDK from the public repository at a pinned commit:

```toml
[features]
paneweft = ["dep:paneweft"]
[dependencies.paneweft]
git = "https://github.com/mikenrafter/paneweft"
rev = "cb01e0e9f7f71b413a00e8851d852b70f37d4dad"
optional = true
```

- **Rev policy.** A full 40-hex commit, never a branch or tag name (two machines or two days build one SDK). The commit must stay reachable from a branch or tag on the remote. The host pins one commit
  (`SDK_GIT_REV` in `src/v1/sdk-source.ts`; the scaffold prints it); `src/v1/sdk-source.test.ts` fails when `crates/` differs from that commit, and when README, this file or the skill quote another rev.
  Bumping an instrumented repository: edit `rev`, then `cargo update -p paneweft --precise <commit>`.
- **Cargo.** `paneweft-macros` is a path dependency of `paneweft` inside the same repository, and the workspace-inherited keys resolve there, so one `paneweft` entry is enough. Cargo needs the git source to resolve the
  lock even with the feature off: run `cargo fetch` once; every later `cargo build --release --offline --locked` works, compiles none of the SDK and links none of it (the SDK's few third-party crates are only in `Cargo.lock`).
- **Offline machines.** `cargo vendor` carries git dependencies; the vendoring script of the earlier recipe is gone because a copy inside the repository goes stale and `cargo vendor` does the same job for every dependency.
- **Nix.** A `rustPlatform.buildRustPackage` build vendors every package of `Cargo.lock`, the optional ones too, so the lock's git source needs a hash even for a feature-off build; without it evaluation fails with
  "No hash was found while vendoring the git dependency paneweft-0.0.0". Add `cargoLock = { lockFile = ./Cargo.lock; outputHashes."paneweft-0.0.0" = "sha256-..."; };` (key `<name>-<version>`; one entry covers
  `paneweft-macros`, which is in the same repository at the same commit; set `lib.fakeHash` once and copy the hash Nix prints). No fileset change is needed (nothing is copied into the repository). Bumping `rev`
  changes the hash: update it in the same commit as `Cargo.lock`. Verified on vigil (`fix-f3-gitdep-report.md`).
- Alternatives rejected: a copy of the SDK inside the instrumented repository (the previous recipe: ~3 300 lines to refresh by hand), a separate instrumentation crate (Rust's orphan rule forbids implementing the SDK's
  trait for a type of another crate, and the spec's point is views beside the code), and a manifest the host generates at collect time (it breaks every `CARGO_MANIFEST_DIR`-relative path).

Tested with real cargo in `test/v1/rust-gitdep.real.test.ts` (the GitHub URL is redirected to a local mirror of this checkout with git's `insteadOf`; manifests and locks hold the real URL and rev).

Green implements every module and wires the tools into the CLI and the MCP server: `grep -rn NOT_IMPLEMENTED src packages crates scripts` is empty. The v0 surface is
unchanged except where `test/v1/surface.test.ts` says otherwise; the v0 pins of the tool count (`src/cli/usage.test.ts`, `src/mcp/server.test.ts`) and the help table
(`src/cli/help.examples.test.ts`) are amended to the twenty-three tools (thirteen v0, ten v1).

## 2. Tagged values (`object-graph.schema.json` `Value`)

Plain JSON for null, boolean, string, finite numbers, arrays and objects. Everything else is an object with the key `$paneweft`:

| Source state | Encoding |
|---|---|
| integer with abs value > 2^53 - 1 (Rust i64/u64/i128, JS bigint) | `{"$paneweft":"bigint","decimal":"..."}` |
| JS bigint or Rust integer within the safe range | the plain number |
| NaN, +/-Infinity, negative zero | `{"$paneweft":"float","value":"NaN"\|"Infinity"\|"-Infinity"\|"-0"}` |
| finite float with an integral value (3.0) | the plain integer number `3` in BOTH languages |
| JS number that is an integer beyond the safe range | `{"$paneweft":"unsupported","reason":"lossy-number"}` (decision 9: reject lossy conversion) |
| bytes | `{"$paneweft":"bytes","base64":"...","length":N}` |
| absent (Rust `Value::Absent`, JS `undefined` or the `absent` marker) | `{"$paneweft":"absent"}`; `null` stays `null` |
| redacted | `{"$paneweft":"redacted","reason":"..."}` (reason optional) |
| unsupported (function, closure, getter) | `{"$paneweft":"unsupported","reason":"function"\|"getter"\|...}`; getters are never evaluated |
| string longer than `limits.stringBytes` | `{"$paneweft":"truncated","text":prefix,"keptBytes":n,"omittedBytes":m}`; the cut never splits a UTF-8 code point |
| bound refused a reference | `{"$paneweft":"not-captured","reason":...,"selector":...}` |
| a data object that has the key `$paneweft` | `{"$paneweft":"map","entries":[[key,value],...]}` |

Display (shape example, list cell): bigint -> the decimal string; float tags -> their `value`; bytes -> `<N bytes>`; absent ->
`<absent>`; redacted -> `<redacted: reason>`; unsupported -> `<unsupported: reason>`; null -> `null`. Object records keep the tag.
Fixture: `fixtures/v1/values.json` (shared by both SDK tests).

## 3. The capture artifact (`paneweft.object-graph/1`)

One document per invocation: `captureId` (equal to the invocation id), `runId` (given by the collector), `roots`, `objects`, `views`,
`pages`, `diagnostics`, `limits`, `completeness`. An **object record** has `id` (`oN`, assigned in registration order, never an
address), `typeId`, `domainKey|null`, `label`, `fields` (tagged values the type declared with `field()`), `edges`, `views` (view ids),
and `contentHash` = sha256 of the canonical JSON (keys sorted at every level, no whitespace) of `{domainKey, fields, label, typeId}`.
Edge kinds: `child` (first discovery), `alias` (later reference to a captured non-ancestor), `cycle` (reference to an ancestor on the
active path), `not-captured` (refused by a bound: `reason`, optional recollection `selector`, no target).

A **view record** carries the v0 component `data` of its first page (`shape` for `details()`, `list` for `table()`), `evidence`
`{provenance:"observed", runId}`, `completeness` (complete | partial with named `omitted` counts | unsupported with a reason and no
data), `pages` (content-addressed further pages) and `rowsTotal`. List rows carry `target:{object}` or
`target:{notCaptured:{reason}}`; the host lowers `target` to the v0 row `entity`. `details()` lowers to a shape: root field
`details` (path `$`, type `object`), one leaf per field (`id` `details.<name>`, `path` `$.<name>`, `example` = display scalar), item
`provenance` `observed`, `evidence` `["run"]`. `table()` lowers to a list: rows sorted stably by `order_by`, row ids are occurrence ids
(`event-<index>`, never the domain id), `order {key, direction}`. A page id is `sha256:` + sha256 of the canonical JSON of the page rows.
A view that fails (panic, thrown error) is isolated: no record for it, a `view-exception` diagnostic naming the view, siblings kept.

## 4. Identity, entities, stored views

Identity is per **observation**: TS `cx.reference` dedupes by object identity inside one publish call (a JavaScript object stays alive
while the capture holds it, so its identity cannot be reused). Rust never dedupes by address (S9): the slot of a dropped temporary is
reused by the next one and a value can change between two references, so every `cx.reference*` call is a new observation unless the
caller names the sharing with `cx.reference_with_identity(name, key, value, token)` (and `publish_with_identity` for a root); separate
unkeyed publish calls are separate observations even for the same value. A domain key never merges objects: equal keys with different content stay
distinct (vigil redelivery).

Host mapping of an object: entity `{repository: <adapter repo>, id: "<captureId>.<objectId>", kind: kindOf(typeId)}`,
`kindOf` = lowercase, `::` -> `/`, CamelCase -> kebab-case (`vigil::watch::WatchFile` -> `vigil/watch/watch-file`). A stored view id is
`<captureId>.<objectId>.<viewId>`; its definition id is the view id; the snapshot id of a run is `snap-<runId>`; the run source is
`{id:"run", kind:"run", run_id, runner_id: <adapter id>, started_at, finished_at}`. Everything stored is an ordinary v0 entity/view,
so `open_entity`, `navigate`, `inspect_view` and the viewer work unchanged.

**Stored pages (D2, D3).** The rows of a list beyond its first page are stored as page *bodies*, `v1/pages/<sha256>.json` = `{pageId, rows}`,
immutable and addressed by their content: identical rows are one file, whoever stored them, and a body is only written when no valid body of that
address is there. Who owns a page is a separate record, `v1/runs/<run>/page-refs.json`, one reference per page keyed by (run, capture, object,
view, position), published inside the import transaction (invisible until the snapshot commits). There is ONE reader of a stored page
(`readPageAt`, read.ts) behind the CLI, the agent tools, the viewer and `V1Reader.page`: it checks the reference, the body's shape, its hash, its
row count, the list-row schema, declared columns, unique row ids over the view and that every row target is an object of the capture. A page that
is not there is `NOT_FOUND` (the tools and the viewer serve the rows they have and name the gap); a page that is there and is not JSON or not a
valid page of its view is `STORAGE_CORRUPT`, on every surface.

## 5. Limits

Defaults (spec section 4): depth 4, objects 1000, references 4000, rootBytes 2 MiB, stringBytes 16 KiB, pageRows 100, collectionBytes
32 MiB, roots 100, viewBudgetMs 100. The spec gives no per-view row cap distinct from the page size; **default `viewRows` = 10 000**
(v0 `factItemsPerView`). Exhaustion never fails a view: `row()` returns `Full{omitted_so_far}`, the view is `partial` with
`omitted.rows`, the capture names `omitted` per limit that bit (`objects`, `references`, `depth`, `rows`, `strings`). References beyond
a bound return a not-captured reference. Depth counts edges from the published root.

**Bytes (D1).** `collectionBytes` bounds the document an SDK writes: the bytes of the JSON text of the whole graph, escaping included, page
bodies included. `rootBytes` bounds the objects, views and stored pages of one root (the objects from that root up to the next one, with their
views and pages; the brackets of the lists belong to the document's frame). Each SDK has ONE path that produces capture output
(`bounded.ts`, `bounded.rs`): every size it charges is the size of text its serializer emitted, a charge is admitted all or nothing, the
document's frame and its worst-case completeness block are charged first, and the bytes of one `not-captured` marker are held back from
ordinary content. A bound below the size of an empty graph cannot be honoured: the SDK writes the empty marked graph (`omitted.collectionBytes`).
The text the SDK counted is the text it writes (`graph.text`), and the host measures the same document independently at admission: the bytes of
the file (or of the re-serialized document), against the declared `collectionBytes`; each root's records against the declared `rootBytes`; and every
declared bound against the operator's ceiling (the adapter's `limitCeilings`).

## 6. Outcome model (`test-run.schema.json`)

Levels (S6): **invocation** (one attempt; `native.outcome` passed|failed|error|skipped|filtered|cancelled|blocked, `capture.outcome`
captured|failed|none), **example** (all attempts retained, the final attempt decides, `priorFailures`, `suiteFailedAfter`),
**suite** (phase setup|teardown|binary|run; attached to its examples, never changes their result), **collection** (`status`
succeeded|failed|cancelled|timed-out|incomplete, exit code, signal, timeout, cancellation, compile ok|failed|skipped, counts).
`failed` = a recorded check failed; `error` = a panic, a thrown non-check or `Result::Err`; `blocked` = a child failed outside an
expected-failure boundary. `verified` = passed AND at least one executed recorded check AND a captured result AND a completed runner
record AND no suite failure after it (a zero-check pass is exploratory; a teardown failure leaves the example `passed` (S6) but not
verified (IV6 spirit)). A selected example with no completion record is synthesized: crash -> `error` ("worker aborted before
completion"), compile failure -> `error` ("not run: compile failed"), timeout or cancel -> `cancelled`. `incomplete` = records are
missing without a timeout or cancel. `meta.origin` is host metadata and is refused in a submitted run.
Literal fixtures for both adapters: `fixtures/v1/outcomes/{cargo,vitest}.scenarios.json`.

## 7. Artifact protocol (worker -> host)

Collector environment: `PANEWEFT_COLLECT=1`, `PANEWEFT_RUN_ID`, `PANEWEFT_STAGING_DIR`, `PANEWEFT_ATTEMPT` (default 1),
`PANEWEFT_CATALOGUE=1` in catalogue mode. Without `PANEWEFT_COLLECT=1` the SDKs write nothing (assertions still run). Layout under
the staging directory: `invocations/<id>.started.json` (written BEFORE the body), `invocations/<id>.json` (completion: the
test-run Invocation without `verified`, plus `finishedAt`), `captures/<captureId>.json`, `catalogue/<binary>.json` (catalogue mode:
`paneweft.catalogue-part/1`: types, views, examples), `reporter.json` (vitest: `paneweft.vitest-report/1` with `tests[{name,file,
state,errors,retries}]`, `suites[{file,phase,outcome,message,examples}]`, `unhandledErrors`). A started record with no completion record
is a missing invocation. The Rust wrapper test of an example is `paneweft_example_<fn>`; the reserved catalogue test is
`paneweft_catalogue_export`; the vitest test title is `example:<id>`.

## 8. Jobs (S2, S3, N1, N2)

Job id = request id; `jobs/<id>/intent.json` (O_EXCL, fsync; a truncated file is treated as never created), `qex.id`, `state.json`
(`paneweft.job/1`), `staging/<runId>/`, `quarantine/`. Run id = `run-<requestId>`. States: intent, submitted, queued, running,
importing, succeeded | failed | cancelled, plus `indeterminate` (never auto-resubmitted). `qex submit` vector: `--dedupe-key
paneweft:<id> --dedupe-window 24h --id-file <job>/qex.id --cwd <root> --name paneweft-<id> --cpu --mem --tag ... --timeout <s>s
--env K=V (sorted) -- <executable> <argv...>`. Recovery: intent without qex id -> `qex list --json` by dedupe key: adopt if found;
submit once if provably absent; else `indeterminate`. Import is idempotent by run id under the write lock (crash points
`before-write`, `after-objects`, `after-manifest`; an importer lease is cleared on exceptional exit and recovered by pid liveness).
Cancel: `qex cancel`; when refused for starting/running, `qex kill` (process group); then wait (bounded) for a terminal qex state
before reporting `cancelled`; during importing -> `cancel-too-late`; after completion -> `already-terminal`. A failing run still imports; the job ends
`failed`. Foreign-run artifacts go to `quarantine/` and the invocation's capture outcome is `failed`.

## 9. Adapters and argv

`paneweft.adapter/1` is owner configuration in `<session>/adapters.json` (CLI `adapter add` only). `cargo-test/1`:
`test --manifest-path <root>/<entry>/Cargo.toml --features <f,...> --lib|--test <target> -- --exact <libtest path>... --test-threads=1`
(env `CARGO_TERM_COLOR=never` + the collector variables); catalogue mode: `... --lib --tests -- paneweft_catalogue_export
--test-threads=1`. `vitest-run/1`: the host-owned `scripts/collect-vitest.mjs` (typecheck, then vitest) with `--staging --root
--tsconfig --vitest --config --name-pattern ^example:<escaped id>$|...`. Selection: ids match `^[a-z0-9][a-z0-9._-]{0,127}$` and must
exist in the catalogue the collection resolves them against (section 10: the run's own export, or a stored catalogue proven fresh); request members `executable argv runner workspaceRoot cwd env shell command` are FORBIDDEN_PROPERTY; examples
of different targets cannot share one process in week one.

The record also pins the environment of its jobs (F21): `env.set` (fixed variables, which win), `env.passthrough` (names taken from the submitting process when it has them; `PANEWEFT_*` is refused in both).
A job is submitted with `qex --env-capture minimal` (HOME, LANG, LOGNAME, PATH, SHELL, USER of the submitter), then the passthrough names (a default list: `RUSTUP_HOME CARGO_HOME RUSTUP_TOOLCHAIN CARGO_TARGET_DIR TMPDIR LC_ALL TERM SSL_CERT_FILE SSL_CERT_DIR`, plus the
record's), then `env.set`. A CLI call from a login shell and an MCP call from a client with a bare environment therefore run the same job for every name the record fixes. A registered rustup `cargo` needs
`RUSTUP_HOME` (and `CARGO_HOME`): pin them with `env.set`. `adapter add` refuses an executable that is not an executable file. A job qex could not start (executable gone, rustup without a default) is a `runner` diagnostic that
says so and names the owner action, not a compile error. A job is driven to its end by a detached driver process the CLI and the MCP server start (F20; `src/v1/driver.ts`), so it advances when nobody polls.

A vitest adapter also names the files its collection reads (F5): `tsconfig` (default `tsconfig.json`; the typecheck that runs before vitest) and `vitestConfig` (default `vitest.config.ts`; the run, which lists the paneweft reporter). Both are paths relative to the package directory (`workspaceRoot/entry`), have no `..` segment, must be existing files (`adapter add` checks), and are refused on a cargo adapter. A `tsconfig` that `extends` the repository's own and lists only what the instrumentation imports keeps a type error in unrelated code (a script, a live test) from blocking every collect.

## 10. Catalogue, inventory, freshness

**A collection resolves its example ids against the catalogue it exports (T4).** `collect` needs no owner-only catalogue step. When a stored catalogue exists
and its recorded input fingerprint still matches the sources (the rule the discovery tools report as `fresh`), it is the export of the very sources the run
would see and resolves the ids at once; an unknown id is NOT_FOUND with candidates and nothing is queued. Otherwise (no catalogue, a stale or doubtful one) the
job has two queue stages: the catalogue export (catalogue mode, `qex.export.id`, dedupe key `<key>:export`), then the run it resolved (`run-stage.json`,
`qex.id`). The export is authoritative for that run: on success it replaces the stored catalogue; an export that fails, or an id the export does not declare,
ends the job `failed` with a diagnostic (the second names the nearest declared ids) and no example runs. A cancel requested before the export ends cancels the
job. `paneweft catalogue refresh` stays an owner command that rebuilds the stored catalogue ahead of time. Discovery on a repository with a registered adapter
but no stored catalogue answers `partial`/`unverified` (never NOT_FOUND), and `scaffold_view` takes an explicit `source` for it.

`paneweft.catalogue/1`: sorted views/examples/types, target + features, linked scope, duplicates; digest = sha256 of the canonical
JSON of `{types, views, examples, target}`. The session keeps `catalogues/<repo>/<adapter>.json` =
`paneweft.catalogue-record/1 {repo, adapter, catalogue, fingerprint, collectedAt}`. Inventory (`paneweft.inventory/1`) lists stable ids
and modules; problems: removed-view, removed-example, missing-module (all ids of a module vanished), unlisted, return-type-changed,
duplicate-id. Coverage reports declared / linked / exercised / passing separately with named gaps (no-example, never-run,
not-passing). Fingerprint members (S10, N5): `git ls-files` + `git ls-files --others --exclude-standard` under the root + declared
extras - explicit exclusions; paths relative to the root (`../../Cargo.lock` for an extra outside it); digest = sha256 of the sorted
lines `<path>\0<sha256>\n`. Before/after sampling is `consistent-sampled` | `mixed-input`; an edit restored between the samples is
undetectable and the note says so. A recompile never refreshes an old observation: freshness compares the run's stored members.

**The inventory file (F27).** `paneweft.inventory.json` sits at the adapter root (`workspaceRoot/entry`), is checked in, and is
`{"schemaVersion":"paneweft.inventory/1","views":[{"id","module"}],"examples":[{"id","module","typeId"}]}` with entries sorted by id.
`module` is the module the compiled catalogue names for the id: the crate-relative module path for Rust (`watch::paneweft_views`), the
repository-relative file path for TypeScript. It guards against LOSS: a declared id the catalogue lacks, a module that exports nothing
any more, a changed return type, a duplicate. An id the catalogue has and the file does not list ("unlisted") is an addition in
progress: a `collect` runs anyway and stores the catalogue with `inventoryDrift.unlisted`, and every discovery reply carries a notice
naming the ids and the command; `catalogue refresh` (the check) fails on it. `paneweft inventory update --repo R --adapter A` (owner
or developer command, CLI only: it writes into the repository) writes the file from the last export, the one the inventory check rejected (kept apart as `rejected-catalogues/<repo>/<adapter>.json` until the adapter is exported again) or else the stored catalogue: it adds the missing entries,
takes the catalogue's module and type for ids it already lists, keeps declared ids the catalogue lacks and says so, and drops them
only with `--prune`.

## 11. Tools and replies

Ten tools (`src/schemas/v1/tools/`); nine required, `scaffold_example` optional. Replies are `paneweft.reply/2` (`reply.schema.json`);
the text form opens `paneweft.reply/2 tool=<name>`, `completeness: ...`, `freshness: fresh (catalogue <digest>) | stale (changed:
<path>, ...) | unverified (...)`, `counts: unit=<u> total=T matched=M returned=R omitted=O truncated=<bool>`, then one line per item,
then `cursor: <token>` when more follows. Budgets, cursors and error codes are v0's (2048-32768, `BUDGET_TOO_SMALL`,
`CURSOR_*`). A type missing from the catalogue is an ok, `partial` reply with a notice naming the linked scope (and "outdated" when
stale): never a statement that no view exists. `scaffold_view` writes nothing; the view body is `unsupported(... TODO ...)`, the output
test fails on an assertion, no field names are invented, a large patch is returned as parts (`part`/`ofParts`) with a cursor.
`list_types` item text: `<typeId> -> <path>:<symbol>; views=<ids|none>; examples=<ids|none>`. Diagnostics get ids `diag-<invocation id>`
for run failures (native failed -> `assertion`, error -> `runner`); SDK diagnostics keep their own id.

## 12. Repo-owned renderers (S4, N3)

Renderer directory `renderers/<id>/` of a registered root: `renderer.json` (id, apiVersion, `payloadSchema`), `bundle.js` (one classic
script), `style.css`. Digest = sha256 of the lines `<file>\0<sha256(file)>\n` for those three files in that order;
`payloadSchemaDigest` = sha256 of the canonical JSON of `payloadSchema`. Trust: `<session>/renderers.trust.json`
(`{trusted:[{repo,id,digest}]}`), CLI only. Routes: `/renderer/<digest>/<token>/{index.html,bundle.js,style.css}` (token minted by
an authenticated API for one frame and one digest, short-lived), headers = `rendererResponseHeaders()` (the S4 CSP plus `base-uri
'none'; form-action 'none'; frame-ancestors 'self'` because those do not fall back to `default-src`). The viewer iframe has
`sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, `data-pw="renderer-frame"`; the parent CSP gains `frame-src 'self'`.
Handshake: parent posts `{protocol:1,type:"bootstrap",nonce,frameId,viewId,snapshotId}` with a MessagePort to the frame window; the
frame's first port message is `ready` echoing the nonce; the host then sends `init` `{payload, objects, theme, locale, label}`. Rejection
order: closed, window, handshake, shape, protocol, frame, view, snapshot, sequence, type (renderer may send ready/resize/select_item/
open_object/request_page/render_error only), size (64 KiB), permitted object, rate. Visible states: `data-pw="renderer-notice"` with
`data-state` untrusted | changed | missing-asset | incompatible | failed | protocol-error (with `data-rejected=<n>`) | revoked; the fallback sits
in `data-pw="renderer-fallback"`. An unexpected second frame load revokes the port. `changed` (F26): the files under the root hash to a digest other than the one the value was captured with; renderer files are not stored with a snapshot (policy: trust follows the reviewed current bytes). A collection compares each declared `assetDigest` and `payloadSchemaDigest` with the files and adds a `renderer` diagnostic on a difference; `paneweft renderers digest --repo R --id ID` prints both. Author guide, page and message protocol: `docs/renderers.md`.

## 13. Trail lowering (S8)

Per entry in `order`: prose `<e>-question` (`**<question>**`), a claim `<e>-option-<id>` (statement `[<status>] <id>: <reason>`,
status `supported` when the option cites evidence else `open`, `supports` = the mapped evidence sources, `contradicts` `[]`), prose
`<e>-decision` (`**Decision:** ...`, plus ` (superseded by <entry>)` when a later entry supersedes it), and an example block
`<e>-dead-end` for `deadEndExample`. All items have provenance `read` and evidence `[trailSourceId]` unless the option cites sources.

## 14. Benchmark harness (S9)

`runBenchmark` calls the question author once (code only, blind to views), then per question one student call (view material for the
condition only, that question only, `tools: []`, `files: null`, no key) and one grader call (question, key, answer; no material);
the examiner is harness code. Conditions A-H as in note 13. Confidence is an integer 0-100 (refused, not clamped). Brier =
mean((confidence/100 - correct)^2); `overconfidentWrong` = wrong with confidence >= 80. Planted-error detection exists only in
condition G. `validateTopic` requires each planted error's `contradictedBy` evidence to appear in the supplied material and every
why-not key to cite a trail entry or recorded evidence.
