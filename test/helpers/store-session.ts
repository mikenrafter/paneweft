// Session helpers for the store suites. Fixture access only; expectations are written as literals in the tests.
import { assert } from "vitest";
import { openSession, type Session, type SessionOptions } from "../../src/core/session.ts";
import type { Bundle } from "../../src/core/wire.ts";
import { allBundle, clone } from "./fixtures.ts";
import { must } from "./must.ts";

export async function openOk(dir: string, options?: SessionOptions): Promise<Session> {
  const opened = await openSession(dir, options);
  if (!opened.ok) assert.fail(`openSession failed: ${opened.error.code}: ${opened.error.message}`);
  return opened.value;
}

export const bundleFixture = (): Bundle => allBundle() as Bundle;

/** The fixture bundle restricted to the named views (entities and definitions stay whole). */
export function subBundle(viewIds: string[]): Bundle {
  const bundle = clone(bundleFixture());
  const views = viewIds.map((id) => {
    const found = bundle.views.find((view) => view.id === id);
    if (!found) throw new Error(`fixture view ${id} not found`);
    return found;
  });
  return { ...bundle, views };
}

/** The same bundle placed in another snapshot: entity and view snapshot ids rewritten. */
export function inSnapshot(bundle: Bundle, snapshotId: string): Bundle {
  const copy = clone(bundle);
  for (const entity of copy.entities) entity.snapshotId = snapshotId;
  for (const view of copy.views) view.snapshotId = snapshotId;
  return copy;
}

export async function importAll(session: Session): Promise<void> {
  must(await session.importBundle(bundleFixture()), "importBundle(all)");
}

/** Literal export order (design 5 + docs/contract-additions/store.md): hand-derived from fixtures/components/all.bundle.json. */
export const SORTED_ENTITY_IDS = ["mcp", "notes", "watch"] as const;
export const SORTED_DEFINITION_IDS = ["def-delivery", "def-example", "def-layout", "def-modules", "def-shape", "def-source", "def-story"] as const;
export const SORTED_VIEW_IDS = ["cancellation-notebook", "check-source", "delivery-path", "layout", "modules", "vigil-one-write", "watch-shape"] as const;
