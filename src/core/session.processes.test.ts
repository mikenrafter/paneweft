// why: S5 requires independent OS processes, synchronized around the read/modify/write window.
// Promise.all of in-process handles cannot prove that a process lock exists. These barriers force
// writer B to attempt its mutation while A holds a manifest read, without sleeps or a timing race.
// (Review S2 replaced the lock with flock; B's waiting is observed as its helper process, test/helpers/lock-writer.ts.)
// proves: CLAIM(S5-process-lock) CLAIM(MC16) CLAIM(MC20)
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { openSession } from "./session.ts";
import { must } from "../../test/helpers/must.ts";
import { isRunning, spawnLockWriter } from "../../test/helpers/lock-writer-host.ts";
import { subBundle } from "../../test/helpers/store-session.ts";
import { demoBlocks, demoNotebook, PAGE_ID } from "../../test/helpers/store-notebook.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); });

describe("[S5] barriered process session writes", () => {
  it.each(["import", "notebook"] as const)("[S5] %s: B cannot read while A holds the manifest; successful writes and notebook history survive", async (kind) => {
    const dir = tmp("process-lock");
    const seed = must(await openSession(dir));
    let revision = 0;
    if (kind === "notebook") {
      must(await seed.importBundle(subBundle(["modules", "delivery-path", "layout", "vigil-one-write"])));
      revision = must(await seed.notebookCreate(demoNotebook())).revision;
    }
    await seed.close();
    const blocksA = demoBlocks(); blocksA[0]!.markdown = "Writer A";
    const blocksB = demoBlocks(); blocksB[0]!.markdown = "Writer B";
    const job = (side: "A" | "B", expectedRevision = revision) => kind === "import"
      ? { kind, bundle: subBundle([side === "A" ? "modules" : "layout"]) }
      : { kind, pageId: PAGE_ID, revision: expectedRevision, blocks: side === "A" ? blocksA : blocksB };
    const a = spawnLockWriter(dir, { ...job("A"), pause: ["before-lock", "read"] }, children);
    const b = spawnLockWriter(dir, { ...job("B"), pause: ["before-lock"] }, children);
    const readyA = await a.waitFor("before-lock"); const readyB = await b.waitFor("before-lock");
    expect(readyA.pid).not.toBe(readyB.pid);
    expect([readyA.pid, readyB.pid]).not.toContain(process.pid);
    a.release("before-lock");
    await a.waitFor("read"); // A holds the lock and has read the manifest
    b.release("before-lock");
    // B's flock helper is waiting in the kernel while A holds the lock: B has not read mutable state (it would otherwise be stale).
    const waiting = await b.waitFor("helper-spawned");
    expect(isRunning(waiting.helperPid!), "B's helper waits for A").toBe(true);
    expect(b.seen.map((event) => event.event), "B never reads while A owns the lock").not.toContain("read");
    a.release("read");
    const doneA = await a.done();
    const doneB = await b.done();
    expect(doneA.result).toMatchObject({ ok: true });
    if (kind === "notebook") {
      // B waited for A, then found the revision it expected gone: the stale write is refused, never applied on top
      expect(doneB.result).toMatchObject({ ok: false, error: { code: "CONFLICT", retryable: true } });
    } else expect(doneB.result, "B waited, then imported its own view on top of A's").toMatchObject({ ok: true });

    const observer = must(await openSession(dir));
    try {
      if (kind === "import") {
        expect((await observer.listViews()).map((v) => v.viewId)).toEqual(doneB.result.ok ? ["layout", "modules"] : ["modules"]);
        must(await observer.importBundle(subBundle(["layout"])));
        expect((await observer.listViews()).map((v) => v.viewId)).toEqual(["layout", "modules"]);
      } else {
        expect(must(await observer.notebookGet(PAGE_ID)).envelope.data).toEqual({ blocks: blocksA });
        must(await observer.notebookUpdate(PAGE_ID, revision + 1, { blocks: blocksB }));
        expect(must(await observer.notebookGet(PAGE_ID)).revision).toBe(revision + 2);
        expect(must(await observer.notebookGet(PAGE_ID)).envelope.data).toEqual({ blocks: blocksB });
        expect(must(await observer.notebookGet(PAGE_ID, revision + 1)).envelope.data).toEqual({ blocks: blocksA });
        expect(must(await observer.notebookGet(PAGE_ID, revision)).envelope.data).toEqual({ blocks: demoBlocks() });
      }
    } finally { await observer.close(); }
  });
});
