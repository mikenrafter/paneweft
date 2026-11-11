// Session set-up for the link suites (MC8): a REAL Session in a temp directory, loaded from committed fixtures.
// Nothing here fakes the unit under test: openSession/importBundle are the production boundary, and a failing import
// fails the calling test by assertion through must().
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import { openSession } from "../../src/core/session.ts";
import type { Session } from "../../src/core/session.ts";
import { FIXTURES } from "./fixtures.ts";
import { must } from "./must.ts";
import { useTempDirs } from "./tmp.ts";

export interface BundleLoad {
  /** Path under fixtures/, e.g. "components/all.bundle.json" or "nav/rows.snap-1.json". */
  file: string;
  /** Applied to the parsed JSON before import (use patch() for one-fault variants). */
  transform?: (parsed: any) => unknown;
  predecessorSnapshotId?: string;
}

export function readFixture(file: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
}

/** Returns a loader that opens a fresh session per call and closes all of them after each test. */
export function useSessions() {
  const tempDir = useTempDirs();
  const open: Session[] = [];
  afterEach(async () => {
    for (const session of open.splice(0)) await session.close().catch(() => {});
  });
  return {
    tempDir,
    async load(...bundles: BundleLoad[]): Promise<Session> {
      const session = must(await openSession(tempDir("session")), "openSession");
      open.push(session);
      for (const entry of bundles) {
        const parsed = readFixture(entry.file);
        const input = entry.transform ? entry.transform(parsed) : parsed;
        must(await session.importBundle(input, entry.predecessorSnapshotId === undefined ? undefined : { predecessorSnapshotId: entry.predecessorSnapshotId }), `importBundle(${entry.file})`);
      }
      return session;
    },
    removeDirectory(path: string): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
