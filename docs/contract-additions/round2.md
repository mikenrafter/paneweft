# Round 2 amendments

The orchestrator's S1-S11 amendments in `paneweft.research/red-report.md` supersede
conflicting defaults in the first red contract. This file makes the additional
test seams and proposed defaults explicit. Business functions remain stubs.

## S1, S2, S4, S8, S11: preserved round 2 contracts

S1 uses only operator-registered repository roots for freshness reads. An
unregistered repository yields unverified with a reason. It cannot expose
whether an envelope-supplied path exists or matches a hash. Status precedence
is stale, unknown, unverified, fresh; mixed results retain unverified entries.

S2 keeps import strict. A dangling claim item rejects the bundle. Resolver
tests wrap a valid imported session to remove a target on read, representing
an unavailable target without relaxing import validation.

S4 adds run sources with run_id, runner_id, started_at, and optional finished_at;
tool sources have name and version. Evidence must cite a declared source.
Observed example runs cite a run source with their own run id. Compiled facts
cite a tool source, with optional file evidence. Existing captured-command
runId evidence remains valid for observed facts outside this new run-source
contract.

S8's ReferenceContext carries definitions with component and entityKind.
Instances must agree with both. Conflicting duplicate entities, definitions,
or view identities report IDENTITY_CONFLICT on the later member. Exact
duplicate entities and definitions are idempotent. A source anchor must find
its repository/path hash in recorded freshness files; a missing record is
DANGLING_REFERENCE on the anchor path.

S11 adds `{snapshotId, viewId, sourceId}` targets to EvidenceStep. Supports
are returned in declared order, then contradicts in declared order. Source
and item targets remain interleaved. A resolved source step includes the
declared source; an unavailable source stays in place with a named unresolved
explanation.

## S3: lossless fragments and progress

An oversized JSON item is delivered as `{fragment: {item_id, offset, length,
total, text}}`. Concatenating `text` in byte-offset order yields the complete
compact JSON serialization of that item. Text output uses
`[fragment item=<id> offset=<offset> length=<length> total=<total>] <text>`;
its payload reconstructs the entire unfragmented item line. Length and offset
measure UTF-8 payload bytes, and boundaries preserve code points. A fragment
is never a permanently clipped item.

The cursor's position is an item index plus an intra-item byte offset. The
cursor is opaque to consumers. Continuation with another budget must neither
restart nor skip the fragmented item. A null cursor means all bytes were
delivered, including the last fragment of the last item.

`returned` counts items whose first byte appears on this page, `omitted` counts
items whose first byte appears later. Thus prior returned + returned + omitted
= matched. A continuation page can have returned=0 while advancing within an
item. `truncated` means more bytes remain, and equals cursor != null. Ordinary
whole-item paging retains its existing counts.

Proposed minimum: max(2048, mandatory serialized header/framing plus room for
64 payload bytes). Framing includes the cursor and fragment metadata, including
JSON escaping overhead. At that budget every page delivers at least a whole
item or a nonempty fragment. A nonterminal fragment uses at least 61 payload
bytes, allowing up to three bytes lost aligning a four-byte code point. A
terminal fragment can deliver the smaller remaining payload. Exact framing is
format-specific; the reported minimum must succeed and one byte below must fail
when it exceeds 2048. The maximum remains 32768.

## S5: process-lock observation

`SessionTestHooks.beforeLockAcquire` runs immediately before acquiring the
write lock. `afterHelperSpawned` runs when the `flock` helper that waits for the
lock has been spawned (round 3, S2 flock rewrite; it replaced `onLockContended`,
because a blocking kernel lock has no "contended" moment to report: a waiting
writer is a live helper process). `afterLockAcquired` runs once the helper
reported the lock held. `afterManifestRead` runs after reading mutable manifest
state inside the acquired lock. `beforeManifestRename` / `afterManifestRename`
bracket the rename that commits a manifest. Each hook is awaited. Production
supplies none.

The test holds A after its read, starts B, and observes B's contention or conflict
before releasing A. B must never read mutable manifest state while A owns the
lock. Blocking and nonblocking locks are both allowed. An import that succeeds
must survive; a retry adds an import that conflicted. Two notebook updates of
one expected revision produce one success and one retryable CONFLICT. Retrying
against the new revision preserves the original and both subsequent revisions.

### S5 mutation record, 2026-11-11

Compute ran on Boat bx_ffzztxnc in `/tmp/paneweft-round2-lock`, outside
`/home/user/paneweft`. The throwaway storage reference came from the earlier
red phase, with only the three awaited observation hooks added. No reference
behavior was copied into the working repository.

`npx vitest run src/core/session.processes.test.ts --reporter=verbose` passed
2/2. `MUT_NO_LOCK=1 npx vitest run src/core/session.processes.test.ts
--reporter=verbose` failed 2/2. Both failures were the same assertion: B reached
`read` while A held its manifest read, where the test requires contention or
CONFLICT. The mutant returns the mutation callback directly instead of
acquiring the process lock. It was enabled only for that throwaway run.

Logs on Boat are `/tmp/paneweft-lock-control.log` and
`/tmp/paneweft-lock-mutation.log`. The locked control took 803 ms and the
unlocked run 694 ms. No grace window or timed absence assertion is involved.

## S6: geometry and outlines

Layer dimensions and positions remain layout/1. Replace the old out-of-canvas
layered self-loop with the contained U route:
`M fx+100 fy+40 L fx+100 fy+52 L fx+60 fy+52 L fx+60 fy+40`.
Same-layer edges route through the left gutter. Downward edges use x=fx-6,
upward edges x=fx-12, entering and leaving at vertical midpoints. The margin
of 16 contains both gutters. Grid edges retain their center-to-center contract;
grid self-loop shape remains unspecified, but its points must be contained.

The dedicated graph geometry golden pins coordinates and paths. Component
outlines pin identity, relationships, status, evidence, and accessibility.
They omit coordinates, paths, canvas size microcopy, and incidental action,
pin, no-target, and match-count wording. Behavior tests still check wording
where the wording conveys a required state.

## S7: HTTP-4 successful browser fixtures

The committed `fixtures/http` responses define successful read bodies:

- `/api/index`: `{entities, views}` with view keys.
- `/api/registry`: `{revision, definitions}`.
- `/api/entity`: `{entity, views: RankOutput}`. The query identifies repository,
  id, kind, and snapshot.
- `/api/view`: `ViewModel` containing envelope, freshness, and contentHash;
  notebook models also contain `notebookRevision`.
- Notebook revision POST: `{expectedRevision, blocks}`; success returns the
  `NotebookPage` with revision and envelope.

All calls carry the session bearer token. Browser edits use a block move
control as described in `docs/viewer-dom-contract.md`. Changing ordered blocks
is sufficient for the S7 notebook edit. Reloading must read the persisted
revision and order. A plain fixture HTTP server supplies the responses; the
shipped IIFE, HTTP source adapter, and DOM code are exercised unchanged.

## S9: registration CLI

`paneweft register --file definition.json --expected-revision N` is flag sugar
for `register_view` with `{definition, expectedRevision}`. Both flags are
required in this form. Missing flags are usage errors, exit 2, stderr only.
`--args` and `--args-file` accept the full operation request as other commands
do. Success, invalid definition, and registry revision conflict have the same
serialized body as MCP. Registry revisions are read from the seeded session;
fixture import's revision increment policy remains unspecified.

## S10: generated declarations

`npm run gen:types` uses `json-schema-to-typescript` 16.0.0, exactly pinned with
its npm lockfile. It resolves the local schema URNs without network access and
generates component declarations plus the envelope's component/data union into
`src/generated`. Conditional envelope and completeness branches are projected
from schema clauses because the generator does not lower those conditionals.
`--check` detects stale declarations without rewriting them. Tests also mutate
an output and a schema input in temporary directories and prove both are caught.

The public `src/core/wire.ts` remains a compile-only red stub with unknown data.
The consumer type test therefore fails by assertion on compiler diagnostics;
the same consumer compiled against the generated declarations passes. Green
must use the generated envelope at the public boundary, adapting its consumers
without adding an independently maintained data type. Semantic constraints
still require Ajv and the semantic validator.

## Demo corrections

Existing fixtures already describe factory calls inside mountLandscape, parser
lines 43-45, bun:test, and vigil's error-flagged cancellation result. Round 2
narrows D2 to what the residual tests assert: sidebar text contains auth after
two view switches, and in a separate test after one hide-filtered toggle. It
does not claim the tests assert stable selected-key identity. The scenario
parameters identify the separate cases and their actual assertion.

Story blocks v3 and ex1 cite the newly declared `sv-e2e` file source for
tests/mcp_e2e.rs. Story freshness records that hash alongside src/mcp.rs. D1
continues to cite sv. No observed run is invented.
