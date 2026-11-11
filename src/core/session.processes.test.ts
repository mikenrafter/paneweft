// why: S5 requires independent OS processes, synchronized around the read/modify/write window.
// Promise.all of in-process handles cannot prove that a process lock exists. These barriers force
// writer B to attempt its mutation while A holds a manifest read, without sleeps or a timing race.
// proves: CLAIM(S5-process-lock) CLAIM(MC16) CLAIM(MC20)
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openSession } from "./session.ts";
import { must } from "../../test/helpers/must.ts";
import { subBundle } from "../../test/helpers/store-session.ts";
import { demoBlocks, demoNotebook, PAGE_ID } from "../../test/helpers/store-notebook.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); });
type Event = { event: "before-lock" | "contended" | "read" | "done"; pid?: number; result?: any };
function writer(dir: string, job: unknown) {
  const child = fork(fileURLToPath(new URL("../../test/helpers/session-writer.ts", import.meta.url)), [dir, JSON.stringify(job)], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const pending: Event[] = [];
  let consumer: ((event: Event) => void) | undefined;
  child.on("message", (event: Event) => {
    if (consumer) { const resolve = consumer; consumer = undefined; resolve(event); }
    else pending.push(event);
  });
  // Unexpected child exit becomes an assertion below, never a hanging test or an import-error failure.
  child.on("exit", () => {
    if (consumer) { const resolve = consumer; consumer = undefined; resolve({ event: "done", result: { childExited: true } }); }
  });
  return {
    next: (): Promise<Event> => pending.length ? Promise.resolve(pending.shift()!) : new Promise((resolve) => { consumer = resolve; }),
    release: (event: string) => child.send({ release: event }),
  };
}

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
    const a = writer(dir, job("A"));
    const b = writer(dir, job("B"));
    const readyA = await a.next(); const readyB = await b.next();
    expect([readyA.event, readyB.event]).toEqual(["before-lock", "before-lock"]);
    expect(readyA.pid).not.toBe(readyB.pid);
    expect([readyA.pid, readyB.pid]).not.toContain(process.pid);
    a.release("before-lock");
    expect((await a.next()).event).toBe("read");
    b.release("before-lock");
    const contender = await b.next();
    // A real lock reports contention (blocking) or CONFLICT (nonblocking). Without it B reaches
    // a stale manifest read. Release every reached barrier, even in that mutation, so it terminates.
    if (contender.event === "contended" || contender.event === "read") b.release(contender.event);
    a.release("read");
    const doneA = await a.next();
    let doneB = contender;
    if (contender.event !== "done") {
      doneB = await b.next();
      if (doneB.event === "read") { b.release("read"); doneB = await b.next(); }
    }
    expect(contender.event, "B may contend or conflict, never read stale state while A owns the lock").not.toBe("read");
    expect(doneA.result).toMatchObject({ ok: true });
    expect(doneB.event).toBe("done");
    if (kind === "notebook" || doneB.result?.ok === false) {
      expect(doneB.result).toMatchObject({ ok: false, error: { code: "CONFLICT", retryable: true } });
    } else expect(doneB.result).toMatchObject({ ok: true });

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
