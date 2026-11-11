// why: dogfooding note #13. `inspect` on a list with several columns printed only the first column of each row in text, so a coding agent
// reading "Folder picker -> (no entity)" never saw the receiver, mechanism or payload, and a bigger budget did not help (the cells were
// never rendered). The text reply must carry every declared column of every row it returns, clip a long cell visibly, and say that it did.
// The expected lines below are hand-derived from the rule in docs/contract-additions/ops.md section 4 (list rows), not produced by running code.
import { describe, expect, it } from "vitest";
import { okJson, okText, useOps } from "../../test/helpers/ops-env.ts";
import { bundleOf, complete, listView, row, treeNode, treeView } from "../../test/helpers/ops-views.ts";
import { patch } from "../../test/helpers/patch.ts";

const open = useOps();
const ARGS = (viewId: string) => ({ viewId, snapshotId: "snap-1" });

const COLUMNS = [
  { key: "sender", title: "Sender", format: "text" },
  { key: "receiver", title: "Receiver", format: "text" },
  { key: "mechanism", title: "Mechanism", format: "text" },
  { key: "payload", title: "Payload / effect", format: "text" },
];
const MESSAGE_ROWS = [
  row("picker-send", { sender: "Folder picker", receiver: "Runtime message gate", mechanism: "runtime.sendMessage", payload: "containmarks:bookmark-tab {tabId, parentId, title}" }),
  row("gate-ack", { sender: "Runtime message gate", receiver: "Folder picker", mechanism: "sendResponse", payload: 42 }),
];
const messages = (extra: Record<string, unknown> = {}) => listView({ id: "messages", definitionId: "def-messages", title: "Messages", columns: COLUMNS, rows: MESSAGE_ROWS, order: { key: "sender", direction: "asc" }, completeness: complete("two messages"), ...extra });

describe("[#13] list text carries every declared column", () => {
  // why: the finding itself. Both rows, all four columns, in declared order, values JSON-quoted so a separator inside a value cannot be misread.
  it("[#13] each row line has the first column, the entity, the trailer and then every other column as key=value", async () => {
    const env = await open(bundleOf([messages()]));
    const body = okText(await env.call("inspect_view", ARGS("messages"))).raw;
    expect(body).toContain('Folder picker -> (no entity); read; s1 | receiver="Runtime message gate" mechanism="runtime.sendMessage" payload="containmarks:bookmark-tab {tabId, parentId, title}"');
    expect(body).toContain('Runtime message gate -> (no entity); read; s1 | receiver="Folder picker" mechanism="sendResponse" payload=42');
  });

  // why: the finding says "more budget does not repair it": the loss must not depend on the budget. A budget big enough for everything and
  //   the smallest one both print whole rows or omit whole rows; no row is ever printed with fewer columns than declared.
  it("[#13] at any budget a returned row shows all its columns (rows are omitted whole, never thinned)", async () => {
    const env = await open(bundleOf([messages()]));
    for (const maxBytes of [2048, 32768]) {
      const body = okText(await env.call("inspect_view", { ...ARGS("messages"), maxBytes })).raw;
      const rowLines = body.split("\n").filter((line) => line.includes(" -> (no entity);"));
      expect(rowLines.length, `rows at ${maxBytes}`).toBeGreaterThan(0);
      for (const line of rowLines) expect(line, `row at ${maxBytes}`).toMatch(/receiver=.* mechanism=.* payload=/);
    }
  });

  // why: a list that already shows its one column keeps its reviewed golden line (operations.components.test.ts); nothing is appended.
  it("[#13] a single-column row is unchanged", async () => {
    const env = await open(bundleOf([listView({ rows: [row("mcp", { name: "mcp.rs" }, { entity: { repository: "r", id: "mcp", kind: "code/module" } })] })]));
    expect(okText(await env.call("inspect_view", ARGS("modules"))).raw).toContain("\nmcp.rs -> code/module:mcp; read; s1\n");
  });

  // why: JSON already kept the cells; the finding asks that both forms be complete. Pin that every cell of every column is in the item. (A
  //   `columns` member in the header was tried and dropped: it is mandatory-part bytes, which the 2048-byte floor cannot afford for a wide list.)
  it("[#13] JSON items carry every cell of every column", async () => {
    const env = await open(bundleOf([messages()]));
    const reply = okJson(await env.call("inspect_view", { ...ARGS("messages"), format: "json" }));
    expect(reply.items.map((item: { cells: unknown }) => item.cells)).toEqual(MESSAGE_ROWS.map((r) => r.cells));
  });

  // why: a cell longer than the clip would make every row huge. It is cut at 160 characters with a marker that states how many were left
  //   out, and the page says that cells were clipped and where the full values are. The JSON form keeps the whole cell.
  it("[#13] a long cell is clipped with an explicit marker and a page-level notice; JSON keeps it whole", async () => {
    const long = "x".repeat(300);
    const env = await open(bundleOf([messages({ rows: [row("long", { sender: "S", receiver: "R", mechanism: "M", payload: long })] })]));
    const text = okText(await env.call("inspect_view", ARGS("messages"))).raw;
    expect(text).toContain(`payload="${"x".repeat(159)}…"[+141 chars]`);
    expect(text).not.toContain("x".repeat(161));
    expect(text).toContain("clipped: 1 cell");
    const reply = okJson(await env.call("inspect_view", { ...ARGS("messages"), format: "json" }));
    expect(reply.items[0].cells.payload).toBe(long);
  });

  // why: control for the notice: when nothing was clipped the page says nothing about clipping.
  it("[#13] no clipping, no notice", async () => {
    const env = await open(bundleOf([messages()]));
    expect(okText(await env.call("inspect_view", ARGS("messages"))).raw).not.toContain("clipped");
  });
});

describe("[#13] tree nodes with several columns", () => {
  // why: the same projection bug sat in the tree text (firstKey only). A node with a second column shows it.
  it("[#13] a tree node line carries its other columns", async () => {
    const columns = [{ key: "name", title: "Name", format: "text" }, { key: "role", title: "Role", format: "text" }];
    const view = patch(treeView({ roots: ["a"], nodes: [treeNode("a", "alpha", [], { cells: { name: "alpha", role: "entry" } })] }), { op: "replace", path: "/data/columns", value: columns });
    const env = await open(bundleOf([view]));
    expect(okText(await env.call("inspect_view", ARGS("layout"))).raw).toContain('alpha [leaf; children=0; read; s1] | role="entry"');
  });
});
