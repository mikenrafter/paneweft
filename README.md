# paneweft

Portable moldable-development views: a catalogue of visualization components that coding agents fill with facts about any codebase, rendered in a local browser viewer and returned to agents as bounded text over MCP and CLI. Derived from Glamorous Toolkit. Design: docs/design.md.

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
2. **`describe --component NAME`**: the component's JSON Schema, limits and one valid example. Copy the example and replace its facts.
3. **`validate --file FILE`**: checks an envelope (`paneweft.view/1`) or a bundle (`paneweft.bundle/1`: entities, view definitions and views together) without storing anything. A failure lists every problem with its pointer and a hint.
4. **`render --file FILE`**: validates again, stores the snapshot atomically and returns a bounded summary plus the viewer URL (when a viewer is running for the session). Stored views are immutable: change a view by submitting it under a new snapshot id.
5. **`inspect`, `open`, `navigate`**: read it back. `inspect` returns a slice of one stored view (filter, order, focus). `open` shows an entity at a snapshot with the views that apply to it. `navigate` follows an item of a pane to its target (another entity, or the source lines behind it with `action: "open-source"`). `search` finds entities, view titles, examples and notebook claims.

Try the whole loop against the committed fixtures (run from the repository root):

```sh try
export PANEWEFT_SESSION="$PWD/.session"
paneweft components
paneweft describe --component list
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

The viewer binds loopback only and every API call needs the per-run token in that URL; the URL is also written to `server.json` in the session directory (mode 0600) so `render` can print a link while a viewer runs. Stop it with Ctrl-C. If the page is blank, run `npm run build:viewer` first.
