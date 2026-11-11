// why: S2, schema-valid column keys must not inject text rows or key=value separators.
// CLAIM(text-column-keys): list and tree pages quote delimiter/control keys while retaining ordinary keys.
import { describe, expect, it } from "vitest";
import { textPages, useOps } from "../../test/helpers/ops-env.ts";
import { bundleOf, listView, row, treeNode, treeView } from "../../test/helpers/ops-views.ts";
import { patch } from "../../test/helpers/patch.ts";

const open = useOps();
const keys = ["plain", "two words", "a=b", "pipe|key", "line\nforged", "tab\tkey", "return\rkey", "nul\0key", 'quote"key', "slash\\key", "delete\x7fkey"];
const columns = [{ key: "name", title: "Name", format: "text" }, ...keys.map((key) => ({ key, title: "Key", format: "text" }))];
// Literal grammar expectations, independent of the rendering helper. JSON escaping keeps every key on the item's one line.
const suffix = ' | plain="v" "two words"="v" "a=b"="v" "pipe|key"="v" "line\\nforged"="v" "tab\\tkey"="v" "return\\rkey"="v" "nul\\u0000key"="v" "quote\\"key"="v" "slash\\\\key"="v" "delete\\u007fkey"="v"';

describe("[S2] column keys through text paging", () => {
  for (const component of ["list", "tree"] as const) {
    // why: enough rows force continuation; every returned row must retain one escaped, unambiguous column trailer on every page.
    it(`[text-column-keys] ${component}: quotes unsafe keys on every page`, async () => {
      const names = Array.from({ length: 12 }, (_, index) => `row-${String(index).padStart(2, "0")}`);
      const cells = (name: string) => ({ name, ...Object.fromEntries(keys.map((key) => [key, "v"])) });
      const view = component === "list"
        ? listView({ columns, rows: names.map((name) => row(name, cells(name))) })
        : patch(treeView({ roots: names, nodes: names.map((name) => treeNode(name, name, [], { cells: cells(name) })) }), { op: "replace", path: "/data/columns", value: columns });
      const env = await open(bundleOf([view]));
      const pages = await textPages(env, "inspect_view", { viewId: view.id, snapshotId: "snap-1" }, 2048);
      expect(pages.length).toBeGreaterThan(1);
      const lines = pages.flatMap((page) => page.reply.body).filter((line) => line.startsWith("row-"));
      expect(lines.map((line) => line.slice(0, 6))).toEqual(names);
      for (const line of lines) expect(line.slice(line.indexOf(" | "))).toBe(suffix);
    });
  }
});
