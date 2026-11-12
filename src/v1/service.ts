// The job service every entry point builds the same way: the registered adapters of the session, the catalogue each one stored, the real qex, and a driver for each job it submits.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Session } from "../core/session.ts";
import { loadAdapters } from "./adapters.ts";
import { spawnJobDriver } from "./driver.ts";
import { createJobService, type JobService } from "./jobs.ts";
import { createQexClient } from "./qex.ts";

/** `drive: false` is for the driver itself (it must not start another one) and for tests that poll. */
export async function createSessionJobService(session: Session, sessionDir: string, options: { drive?: boolean } = {}): Promise<JobService> {
  const directory = resolve(sessionDir);
  const adapters = await loadAdapters(directory);
  return createJobService({
    session,
    sessionDir: directory,
    qex: createQexClient(),
    adapters: adapters.ok ? adapters.value : [],
    ...(options.drive === false ? {} : { drive: spawnJobDriver(directory) }),
    catalogueFor: async (repo, adapter) => {
      try {
        return (JSON.parse(await readFile(resolve(directory, "catalogues", repo, `${adapter}.json`), "utf8")) as { catalogue: never }).catalogue;
      } catch {
        return null;
      }
    },
  });
}
