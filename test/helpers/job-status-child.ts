// Real child process for the job-status tests (jobs.test.ts, S41): a second job service, in its own process, running one `status` on a job.
// argv: sessionDir, jobId, JSON { adapter, catalogue (path), waitSeconds, maxLogBytes }. Messages to the parent: {event:"started"} before the call,
// {event:"done", result} after it. The qex client is the fake one the parent put on PATH (its environment is inherited).
import { readFileSync } from "node:fs";
import { openSession } from "../../src/core/session.ts";
import { createJobService } from "../../src/v1/jobs.ts";
import { createQexClient } from "../../src/v1/qex.ts";

const [dir, id, optionsText] = process.argv.slice(2);
const options = JSON.parse(optionsText!) as { adapter: never; catalogue: string; waitSeconds: number; maxLogBytes?: number };
const opened = await openSession(dir!);
if (!opened.ok) throw new Error(opened.error.message);
const catalogue = JSON.parse(readFileSync(options.catalogue, "utf8"));
const service = createJobService({ session: opened.value, sessionDir: dir!, qex: createQexClient({ env: process.env }), adapters: [options.adapter], catalogueFor: async () => catalogue, cancelWaitMs: 3000 });
process.send!({ event: "started" });
const result = await service.status(id!, { waitSeconds: options.waitSeconds, ...(options.maxLogBytes === undefined ? {} : { maxLogBytes: options.maxLogBytes }) });
process.send!({ event: "done", result });
await opened.value.close();
process.exit(0);
