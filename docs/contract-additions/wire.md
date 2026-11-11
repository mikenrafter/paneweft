# Contract additions: transports (tag: wire)

Questions that design.md and `docs/red-contract.md` leave open for the CLI, the stdio MCP server and the viewer
HTTP server. Each has the default the red tests pin and the tests that cite it. The owner can overturn any of them.
Red-contract 9 says "stdout = the reply body" and "CLI and MCP bodies for the same request are byte-identical"; the
defaults below are chosen so that this stays literally true.

## CLI

**CLI-1. `--args` together with `--args-file`.** Default: usage error (exit 2, both flags named on stderr). Reason: two
request sources are ambiguous and silently preferring one would hide a mistake. Cited in `main.test.ts` usage matrix.

**CLI-2. A missing required tool argument is not a usage error.** `paneweft describe` (no `--component`) forwards `{}`
and gets the tool's `INVALID_ARGUMENT` (`REQUIRED /component`), exit 1, the same body MCP returns for `{}`. Usage errors
(exit 2) are only: unknown command/flag/subcommand, stray positional, a flag without its value, `--args`/`--args-file`/
`--file` content that is not readable JSON, `--max-bytes` that is not a base-10 integer, `--args` with `--args-file`.
Reason: parity (MC11) needs one error model, and the CLI cannot know which arguments a tool will require.
Usage errors win over `SESSION_REQUIRED` (arguments are parsed before anything runs).

**CLI-3. Which operations need a session.** `components`, `describe`, `validate` run without one (the operation layer
agrees: ops tests pin `list_components`, `describe_component`, `validate` as session-free). The other commands without a
session: exit 1 with `SESSION_REQUIRED`.

**CLI-4. Sugar flags merge into `--args`.** `--args '{"component":"graph"}' --format json` equals
`--args '{"component":"graph","format":"json"}'`. What happens when a flag and `--args` give the SAME key is untested
(proposed: usage error). `--max-bytes` reaches the operation as a number; `--file F` becomes `{"input": <contents of F>}`
(for `validate`, `render`, `notebook create`).

**CLI-5. Precedence of session selection:** `--session DIR` beats `PANEWEFT_SESSION`.

**CLI-6. `example run` flags.** The contract names no way to select the owner registry or the target view.
Proposed: `paneweft [--session DIR] example run <runnerId> --runners FILE --view VIEW_ID --snapshot SNAPSHOT_ID`.
No registry configured (flag absent) behaves as an empty registry: `RUNNER_NOT_FOUND`. (Proposed fallback env
`PANEWEFT_RUNNERS` is not tested.) The CLI has no `register_view` command (red-contract 9 lists none); that tool is
MCP-only.

## MCP

**MCP-1. Arguments that violate the advertised schema** are not an SDK protocol error: the call reaches the shared
validator and returns `isError: true` with the `INVALID_ARGUMENT` body (same as the CLI), so pointers are visible.

**MCP-2. Unknown tool name:** `isError: true` with code `UNKNOWN_OPERATION` (an existing operation code), not a JSON-RPC
error.

**MCP-3. A server started without `--session`** serves `list_components`, `describe_component`, `validate`; the other
tools answer `SESSION_REQUIRED`.

## HTTP (viewer)

**HTTP-1. Unknown route:** `404` with `paneweft.error/1`, code `NOT_FOUND` (the code list has no more specific one).
An unknown `viewId`/`snapshotId` on `/api/view` is also `404 NOT_FOUND`.

**HTTP-2. Status of a stale notebook write:** `409` with code `CONFLICT` and `details.currentRevision`. Malformed JSON
body: `400` with `paneweft.error/1`. A refused Origin or Host is `403 FORBIDDEN_ORIGIN`; a missing/wrong token `401
UNAUTHORIZED`. Success of `POST /api/notebooks/<pageId>/revisions` is `200` or `201` (tests accept both; the stored page is
the arbiter).

**HTTP-3. Response shapes the red-contract does not spell out** (pinned by `server.test.ts`):
* `GET /api/index` -> `{ "views": [{ "viewId", "snapshotId", ... }] }`, one entry per stored view.
* `GET /api/registry` -> `{ "revision": <integer>, "definitions": [...] }` (what `Session.listDefinitions()` returns).
* `GET /api/entity` -> a JSON document that contains every applicable definition id as a JSON string.
* `GET /api/source?viewId&snapshotId&itemId` -> `{ "currency": "current" | "stale" | "unknown", "numberedLines":
  [{ "n": <file line number>, "text" }], "highlight": [first, last], "revision": <recorded gitRev or null>, ... }`.
  `numberedLines` are always the STORED excerpt lines (numbered from the anchor's first line); `highlight` is the lines of the
  item addressed by `itemId` (annotation `lines`, or the excerpt anchor's `lines` for the excerpt item); `revision` is the
  `gitRev` recorded in the view's freshness block for the anchor's repository. `currency`: `current` = registered root
  whose file bytes match the recorded sha256, `stale` = bytes differ, `unknown` = repository not registered or unreadable.

## Reply shapes used by the wire tests

**WIRE-1. `validate` success.** Proposed JSON body: an object with `"valid": true` (plus optional notes). The contract says only
"returns valid". Text form is unpinned.

**WIRE-2. JSON replies.** `render`, `inspect_view`, `open_entity` and `notebook_get` JSON bodies are `reply.schema.json`
objects with the reply fields at the top level: `view.id`, `counts`, `cursor`, `items[]` where each item has `id`. `render` adds
`viewerUrl` (string or null) at the top level. For `render` text, the summary header may be preceded by other lines (ids,
URL); tests locate it by its first line `paneweft.reply/1 ...`. For a notebook page `view.id` is the page id and the unit is
`blocks`.

**WIRE-3. Page id.** `pageId` equals the notebook envelope's `id` (also pinned by the store tests, `store.md`).
