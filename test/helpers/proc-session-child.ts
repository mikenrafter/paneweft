// Child process of the S5 multi-process session tests. Runs ONE session operation with a barrier inside the critical
// section: Session test hook `beforeManifestSwap` is called while the operation holds whatever protects the
// read-modify-write of the manifest, so a second process that is also inside it proves there is no mutual exclusion.
//
// argv: <session dir> <barrier dir> <child id> <operation JSON>
//   operation: {"op":"import","bundleFile":"<path>"} | {"op":"notebookUpdate","pageId":..,"expectedRevision":N,"blocksFile":"<path>"}
// protocol files in the barrier dir (all written by whoever is named):
//   ready.<id>   child: module loaded and session opened          start        parent: begin the operation (both children at once)
//   reached.<id> child: inside the critical section, waiting      go.<id>      parent: leave the critical section
// stdout: one JSON line `{ok:true, value?}` or `{ok:false, code, details?}`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession } from "../../src/core/session.ts";

const [sessionDir, barrierDir, id, operationJson] = process.argv.slice(2) as [string, string, string, string];
const operation = JSON.parse(operationJson) as Record<string, any>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(file: string): Promise<void> {
  while (!existsSync(join(barrierDir, file))) await sleep(5);
}

const opened = await openSession(sessionDir, {
  testHooks: {
    beforeManifestSwap: async () => {
      writeFileSync(join(barrierDir, `reached.${id}`), "");
      await until(`go.${id}`);
    },
  },
});
if (!opened.ok) {
  console.log(JSON.stringify({ ok: false, code: opened.error.code }));
  process.exit(0);
}
const session = opened.value;
writeFileSync(join(barrierDir, `ready.${id}`), "");
await until("start");

const result =
  operation.op === "import"
    ? await session.importBundle(JSON.parse(readFileSync(operation.bundleFile, "utf8")))
    : await session.notebookUpdate(operation.pageId, operation.expectedRevision, { blocks: JSON.parse(readFileSync(operation.blocksFile, "utf8")) });
console.log(JSON.stringify(result.ok ? { ok: true } : { ok: false, code: result.error.code, details: result.error.details ?? null }));
await session.close();
