// why: dogfooding note #19. `navigate --action open-source` answered UNRESOLVED_TARGET for an item whose anchor names a file under a registered, fresh
//   repository root whenever no stored source view happened to cover the anchor: the session had the repository, the file was there, hash and all, and
//   still nothing opened. The resolution now falls back to the confined read path (the same one freshness uses, capped at 16 MiB): when the recorded hash
//   equals the file's bytes the anchored lines are read from the file itself and the answer says it did (origin registered-root). In every other case the
//   answer is still UNRESOLVED_TARGET, but it names the missing excerpt, why the file was not read, and the fix.
// CLAIM(source-currency): a stored excerpt still wins when one covers the anchor (control below); live lines are shown only for a file that is fresh.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../test/helpers/hash.ts";
import { failure, okJson, okText, useOps } from "../../test/helpers/ops-env.ts";
import { SHA, bundleOf, listView, row, sourceView, withFreshnessRoot, type Json } from "../../test/helpers/ops-views.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { MAX_CONFINED_FILE_BYTES } from "./confined-read.ts";

const open = useOps();
const tempDir = useTempDirs();
const PATH = "src/standardHandler.ts";
const FILE = ["import x from 'x';", "", "export function mapping() {", "  return choose();", "}", ""].join("\n");
const PANE = { entity: { repository: "r", id: "watch", kind: "vigil/watch" }, snapshotId: "snap-1", viewDefinitionId: "def-modules", selection: [], filters: {}, pinned: false };

function write(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A list view whose row `m` is anchored at lines 3-4 of PATH, recorded with `recorded` as the file's hash; no source view in the bundle. */
function anchoredBundle(root: string, recorded: string, lines: [number, number] = [3, 4]): Json {
  const view = withFreshnessRoot(listView({ rows: [row("m", { name: "mapping" }, { anchor: { repository: "r", path: PATH, lines } })] }), root, { [PATH]: recorded });
  return bundleOf([view]);
}
async function setup(options: { content?: string | Buffer; recorded?: string; lines?: [number, number]; register?: boolean } = {}) {
  const root = tempDir("root");
  const content = options.content ?? FILE;
  write(root, PATH, content);
  const env = await open(anchoredBundle(root, options.recorded ?? sha256Hex(content), options.lines));
  if (options.register !== false) await env.session.registerRepository({ id: "r", root });
  return { env, root };
}
const NAV = { pane: PANE, itemId: "m", action: "open-source" } as const;

describe("[#19] open-source reads a fresh registered file when no excerpt covers the anchor", () => {
  // why: the finding. Fresh file, registered root, no covering excerpt: the anchored lines come from the file, highlighted, and the reply says where they came from.
  it("[#19] JSON: the lines 3-4 of the file, highlight 3-4, currency fresh, origin registered-root, no stored view", async () => {
    const { env } = await setup();
    const reply = okJson(await env.call("navigate", { ...NAV, format: "json" }), { schema: false });
    expect(reply).toMatchObject({ schemaVersion: "paneweft.source/1", repository: "r", path: PATH, highlight: [3, 4], origin: "registered-root", storedView: null, currency: { state: "fresh" } });
    expect(reply.items.map((item: { line: number; text: string; highlighted: boolean }) => [item.line, item.text, item.highlighted])).toEqual([[3, "export function mapping() {", true], [4, "  return choose();", true]]);
  });

  it("[#19] text: the origin line and the numbered lines", async () => {
    const { env } = await setup();
    const text = okText(await env.call("navigate", NAV)).raw;
    expect(text).toContain("origin: registered-root");
    expect(text).toContain("3: export function mapping() {");
    expect(text).toContain("4:   return choose();");
    expect(text).toContain("currency: fresh");
  });

  // why: the cap of the confined read path (16 MiB) holds here too: a file of exactly the cap reads, one byte more is refused with an answer that names the cap.
  it("[#19] a file of exactly 16 MiB opens; one byte more is UNRESOLVED_TARGET naming the cap", async () => {
    const head = FILE;
    const exact = Buffer.concat([Buffer.from(head), Buffer.alloc(MAX_CONFINED_FILE_BYTES - Buffer.byteLength(head), 0x61)]);
    const big = await setup({ content: exact });
    expect(okJson(await big.env.call("navigate", { ...NAV, format: "json" }), { schema: false }).origin).toBe("registered-root");
    const over = await setup({ content: Buffer.concat([exact, Buffer.from("a")]), recorded: sha256Hex("whatever") });
    const error = failure(await over.env.call("navigate", NAV));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    expect(error.message).toContain(String(MAX_CONFINED_FILE_BYTES));
  }, 60_000);

  // why: the stored excerpt wins when one covers the anchor, so nothing that resolved before changes origin. Control, green by design.
  it("[#19] control: a covering stored excerpt is still used (origin stored-excerpt, its view named)", async () => {
    const list = withFreshnessRoot(listView({ rows: [row("m", { name: "mapping" }, { anchor: { repository: "r", path: "src/check.ts", lines: [4, 4] } })] }), "/work/r", { "src/check.ts": SHA });
    const env = await open(bundleOf([list, sourceView()]));
    const covered = okJson(await env.call("navigate", { ...NAV, format: "json" }), { schema: false });
    expect(covered).toMatchObject({ origin: "stored-excerpt", storedView: "check-source", highlight: [4, 4] });
  });
});

describe("[#19] when the file cannot be read the answer names the missing excerpt and the fix", () => {
  const explains = (message: string) => {
    expect(message).toContain(`${PATH}:3-4`);
    expect(message).toContain("no stored source excerpt");
    expect(message).toContain("source view"); // the fix: submit a source view whose excerpt covers the lines
  };

  // why: a changed file would show lines the view's author never saw at those line numbers; refuse, say the file changed, say how to fix.
  it("[#19] a file that no longer matches the recorded hash is not shown: the answer says the hash differs", async () => {
    const { env } = await setup({ recorded: sha256Hex("an older version\n") });
    const error = failure(await env.call("navigate", NAV));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    explains(error.message);
    expect(error.message).toContain("hash");
  });

  // why: without a registered root nothing may be read (CLAIM(no-read-before-deny)); the fix is to register the repository.
  it("[#19] an unregistered repository: the answer names the repository and says to register it", async () => {
    const { env } = await setup({ register: false });
    const error = failure(await env.call("navigate", NAV));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    explains(error.message);
    expect(error.message).toMatch(/register/);
    expect(error.message).toContain('"r"');
  });

  // why: lines beyond the end of the file cannot be opened; the message gives the file's real length.
  it("[#19] anchor lines beyond the end of the fresh file: the answer states how many lines the file has", async () => {
    const { env } = await setup({ lines: [3, 99] });
    const error = failure(await env.call("navigate", NAV));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    expect(error.message).toContain("5 lines");
  });
});
