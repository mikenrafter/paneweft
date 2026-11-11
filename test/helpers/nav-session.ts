// Session set-up for the link suites (MC8): a REAL Session in a temp directory, loaded from committed fixtures.
// Nothing here fakes the unit under test: openSession/importBundle are the production boundary, and a failing import
// fails the calling test by assertion through must().
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import { openSession } from "../../src/core/session.ts";
import type { Session, ViewKey } from "../../src/core/session.ts";
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

function stripItem(node: unknown, itemId: string): unknown {
  if (Array.isArray(node)) return node.filter((child) => !(child !== null && typeof child === "object" && (child as { id?: unknown }).id === itemId)).map((child) => stripItem(child, itemId));
  if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, stripItem(value, itemId)]));
  return node;
}

/**
 * S2: the controlled RESOLVER FIXTURE. Import is strict (a dangling `{viewId,itemId}` is refused), so an unresolved
 * navigation target cannot be produced by importing an invalid bundle. This wraps a REAL session so that one stored view
 * reads back WITHOUT one item: the state after a valid import whose target was later removed (pruned storage, a
 * newer partial rewrite). Everything else is delegated to the real session unchanged; only `getView` of `key` differs.
 */
export function sessionWithoutItem(session: Session, key: ViewKey, itemId: string): Session {
  return new Proxy(session, {
    get(target, property) {
      if (property === "getView") {
        return async (requested: ViewKey) => {
          const result = await target.getView(requested);
          if (!result.ok || requested.viewId !== key.viewId || requested.snapshotId !== key.snapshotId) return result;
          return { ok: true as const, value: { ...result.value, envelope: stripItem(result.value.envelope, itemId) as typeof result.value.envelope } };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** S11 twin of sessionWithoutItem: one stored view reads back WITHOUT one declared source (a source removed after a valid import). */
export function sessionWithoutSource(session: Session, key: ViewKey, sourceId: string): Session {
  return new Proxy(session, {
    get(target, property) {
      if (property === "getView") {
        return async (requested: ViewKey) => {
          const result = await target.getView(requested);
          if (!result.ok || requested.viewId !== key.viewId || requested.snapshotId !== key.snapshotId) return result;
          const envelope = { ...result.value.envelope, sources: result.value.envelope.sources.filter((source) => source.id !== sourceId) };
          return { ok: true as const, value: { ...result.value, envelope } };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
