# paneweft

Portable moldable-development views: a catalogue of visualization components that coding agents fill with facts about any codebase, rendered in a local browser viewer and returned to agents as bounded text over MCP and CLI. Derived from Glamorous Toolkit. Design: docs/design.md.

## Requirements

* Node.js >= 22.12.
* Linux with **util-linux `flock(1)` on `PATH`**. Every write to a session directory (imports, view registration, notebook updates, recorded runs) takes a kernel file lock through that program, so two processes can never update the same session at once and a crashed writer never leaves a stale lock. Without it every write fails with `STORAGE_FAILED` (`details.cause: "flock-missing"`, message naming util-linux); reading a session needs nothing. util-linux is part of every mainstream Linux distribution (Debian and Ubuntu: package `util-linux`, installed by default; Alpine: `apk add util-linux`; NixOS: `pkgs.util-linux`). macOS and Windows do not ship it.
