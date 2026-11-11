# Contract additions: store agent (anchors, freshness, session, notebooks, runners)

Each item is a decision the design and red-contract leave open. The default is what the red tests pin;
the owner can overturn any of them (then the cited test changes). Numbers are cited from the tests as `store.md#N`.

1. **Anchor lines.** `numberedLines[i].text` excludes the line terminator (`\n` and `\r\n`). A file ending in `\n`
   has no extra empty last line; an empty file has zero lines. `relativePath` is the normalised requested path
   (a leading `./` is dropped). `fileSha256` is over the raw bytes of the whole file.
2. **Anchor errors.** `INVALID_PATH` is lexical: empty path, NUL, any backslash, absolute path, any `..` segment.
   `PATH_OUTSIDE_ROOT` is for a path that is lexically fine but whose canonical (realpath) target leaves the
   canonical root (symlinks, including sibling-prefix targets such as `repo-evil` next to `repo`).
   **Conflict in the brief:** it lists `../secret.txt` under INVALID_PATH and `../repo-evil/f` under PATH_OUTSIDE_ROOT,
   but both are lexically identical. I pinned `../repo-evil/f` as INVALID_PATH and test the sibling-prefix
   confusion through a symlink instead (that is the form where a `startsWith(root)` bug actually matters).
   Neither error carries `details` and neither echoes file content.
3. **Freshness details.** `changedPaths` are sorted by repository (envelope order) then path (code-unit order).
   `inaccessibleRoots` lists the root that was actually tried (the override when one is given). A root is
   inaccessible when it is not a readable directory. A recorded path that is absolute, contains `..`, or whose
   realpath leaves the root is never read: it is reported as changed with `currentSha256: null`.
4. **Deterministic order.** `listViews`: by (viewId, snapshotId). `listEntities`: (repository, id, kind, snapshotId).
   `listDefinitions` / export definitions: by id. Export views: by (id, snapshotId). Code-unit comparison.
5. **Idempotence.** Re-importing identical content succeeds and does not change the registry revision.
   Whether a first import bumps the revision once or once per definition is NOT pinned (tests compare against
   `ImportSummary.registryRevision`).
6. **Definitions are stored as submitted.** The default priority 50 is applied by `rankViews`, not written back;
   an explicit `priority: 0` survives. (Consistent with red-contract 5.)
7. **Repositories** are returned sorted by id and persist across `openSession`.
8. **Notebook update** replaces `data.blocks` (and `sources` when given); every other envelope field is carried over
   from the latest revision. The caller sends the complete block list; a status change to `disputed` is just a new
   list in which the claim keeps its `supports`. *Question:* should an update that silently drops a claim's old
   `supports` be rejected ("keep the old evidence")? Default: no, the old revision stays addressable.
9. **Notebook pages.** `pageId` = `envelope.id`; the page envelope is checked like a view (entity and definition
   must be registered, see putView). Export carries the LATEST revision of each page as a `views[]` entry
   (component `notebook`); importing a bundle with a notebook view makes it revision 1 of that page. Revision
   history is not exported. *Questions not pinned:* creating a page whose id exists (default: `CONFLICT`);
   whether block `viewId` / `{viewId,itemId}` targets must exist in the session (tests only use existing ones).
10. **Runners.** Calling convention of the fixture runners: spawned without a shell, cwd = `workspaceRoot`,
    env `PANEWEFT_RUN_ID`, output written to `outputBundlePath` relative to cwd. A missing registry file is
    `RUNNER_NOT_FOUND`. Spawn failure and a non-zero exit are `RUNNER_FAILED` (`details.exitCode` for the exit).
    Any validation failure of runner output (schema or semantic) is `RUNNER_OUTPUT_INVALID` with the issues in
    `errors`. Parameter faults are `INVALID_ARGUMENT` with Ajv-style issues at `/parameters/<name>`. Substitution
    of `{param:name}` is a single pass; numbers and booleans become `String(value)`.
11. **RecordedRun.contentHash** = sha256 of the canonical JSON (sorted keys, no whitespace) of the whole
    `paneweft.run/1` output document. Runs are listed in recording order.
12. **Run evidence.** `run.evidence` / `assertions[].evidence` resolve against the sources of the example view the
    run is recorded on (`/run/evidence/N` is DANGLING_REFERENCE otherwise). The fixtures use provenance `read`; a
    run that is honestly `observed` needs a source with a `runId`, which `paneweft.run/1` has no place to carry.
    **Design gap:** the run schema should let the output add `sources`, or define run provenance differently.
13. **Recording against a non-example view** (e.g. a list view) is `INVALID_ARGUMENT`. Recording against an
    unknown (view, snapshot) is `NOT_FOUND`.
14. **Hooks.** `afterWrite.count` is 1-based and per mutation. `beforeManifestSwap` throwing and `afterWrite` throwing
    both give `STORAGE_FAILED`. After a failure nothing of the mutation is visible; orphan staged files are
    allowed (unmanifested files are never listed). Only VALIDATION failures are asserted to leave the directory
    tree byte-identical (nothing is staged before validation).
15. **Concurrency.** Two handles on one directory serialise mutations. For imports the tests accept either
    "both succeed" or a retryable `CONFLICT` for the loser, never a lost update. Notebook updates from one
    revision: exactly one ok, the rest `CONFLICT` with `details.currentRevision`.
