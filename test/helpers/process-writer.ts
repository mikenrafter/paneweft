// A real child process running test/helpers/session-writer.ts, with a named event queue (review S2). Unlike the single-consumer
// helper inside session.processes.test.ts, several events can be awaited by name, in any order, from several writers.
// Barriers: the child reports an event and then waits until the test calls `release(event)`; "stale-resolved" and "done" are only reported.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface WriterEvent { event: string; pid?: number; broke?: boolean; target?: string; result?: any }
export interface ProcessWriter {
  /** The next unread event with this name; rejects if the child exits first without ever sending it. */
  waitFor(event: string): Promise<WriterEvent>;
  /** Drops waiters for `event` that lost a race (see firstToSend), so a later event is not delivered to a promise nobody reads. */
  cancelWaits(event: string): void;
  release(event: string): void;
  readonly child: ChildProcess;
}

export function spawnWriter(dir: string, job: unknown, registry: ChildProcess[]): ProcessWriter {
  const child = fork(fileURLToPath(new URL("./session-writer.ts", import.meta.url)), [dir, JSON.stringify(job)], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  registry.push(child);
  const unread: WriterEvent[] = [];
  const waiting: Array<{ event: string; resolve: (event: WriterEvent) => void; reject: (error: Error) => void }> = [];
  let exited = false;
  child.on("message", (message: WriterEvent) => {
    const index = waiting.findIndex((waiter) => waiter.event === message.event);
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message);
    else unread.push(message);
  });
  child.on("exit", () => {
    exited = true;
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(`writer exited before sending "${waiter.event}"`));
  });
  return {
    child,
    waitFor: (event) => {
      const index = unread.findIndex((candidate) => candidate.event === event);
      if (index >= 0) return Promise.resolve(unread.splice(index, 1)[0]!);
      if (exited) return Promise.reject(new Error(`writer exited before sending "${event}"`));
      return new Promise((resolve, reject) => waiting.push({ event, resolve, reject }));
    },
    cancelWaits: (event) => {
      for (let index = waiting.length - 1; index >= 0; index -= 1) if (waiting[index]!.event === event) waiting.splice(index, 1);
    },
    release: (event) => { if (child.connected) child.send({ release: event }); },
  };
}

/** Passes the named barriers of `writer` as they occur (each as often as it occurs) without the test having to know whether they will occur at all. */
export function autoRelease(writer: ProcessWriter, events: readonly string[]): void {
  for (const event of events) {
    void (async () => {
      for (;;) {
        try { await writer.waitFor(event); } catch { return; } // the writer exited
        writer.release(event);
      }
    })();
  }
}

/** Whichever writer sends `event` first, with the losers' waiters withdrawn. */
export async function firstToSend(writers: readonly ProcessWriter[], event: string): Promise<{ writer: ProcessWriter; sent: WriterEvent }> {
  try {
    return await Promise.race(writers.map((writer) => writer.waitFor(event).then((sent) => ({ writer, sent }))));
  } finally {
    for (const writer of writers) writer.cancelWaits(event);
  }
}
