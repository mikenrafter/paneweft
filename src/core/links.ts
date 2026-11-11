// Cross-view links and evidence (design section 3, MC8): exact addressing by snapshot, view
// instance and optional item. Navigation never silently mixes snapshots; a missing target is a
// named unresolved result, never the newest snapshot.
//
// CLAIM(links-exact): a link names (snapshot, view, item) or (snapshot, entity); resolution never substitutes another snapshot, and
//   the precedence of misses is snapshot, then view or entity, then item [links.test.ts, MC8].
// CLAIM(source-currency): the stored excerpt lines are returned whether the registered file is fresh, stale or unreachable; only
//   `currency` says which, by comparing the recorded hash with the operator-registered root's bytes [links.test.ts, MC6/MC8].
import type { EntityRef, Source } from "./wire.ts";
import type { Session, ViewKey } from "./session.ts";
import type { NumberedLine } from "./anchors.ts";
import { rankViews } from "./registry.ts";
import { currentFileHash } from "./freshness.ts";
import { viewItems, type AnyItem } from "./items.ts";
import { compareCodeUnits } from "./canonical.ts";

export type LinkTarget =
  | { snapshotId: string; viewId: string; itemId?: string }
  | { snapshotId: string; entity: EntityRef; preferredViewDefinitionId?: string };

export type LinkResolution =
  | {
      status: "resolved";
      snapshotId: string;
      viewId?: string;
      itemId?: string;
      entity?: EntityRef;
      viewDefinitionId?: string;
      fallback?: { requested: string; used: string; reason: string };
    }
  | { status: "unresolved"; code: "UNRESOLVED_TARGET"; missing: "snapshot" | "view" | "item" | "entity" | "source"; message: string };

const unresolved = (missing: "snapshot" | "view" | "item" | "entity", message: string): Extract<LinkResolution, { status: "unresolved" }> => ({ status: "unresolved", code: "UNRESOLVED_TARGET", missing, message });

/** The entity an item opens: its own `entity`, or for an example run the `result` it produced. */
const entityOfItem = (item: AnyItem): EntityRef | undefined => (item.entity ?? (item.result as EntityRef | undefined));

export async function resolveLink(session: Session, target: LinkTarget): Promise<LinkResolution> {
  const snapshot = await session.snapshotInfo(target.snapshotId);
  if (!snapshot.ok) return unresolved("snapshot", `snapshot "${target.snapshotId}" does not exist`);
  if ("viewId" in target) {
    const stored = await session.getView({ viewId: target.viewId, snapshotId: target.snapshotId });
    if (!stored.ok) return unresolved("view", `view "${target.viewId}" does not exist in snapshot "${target.snapshotId}"`);
    const envelope = stored.value.envelope;
    if (target.itemId === undefined) return { status: "resolved", snapshotId: target.snapshotId, viewId: target.viewId, viewDefinitionId: envelope.viewDefinitionId };
    const item = viewItems(envelope).find((candidate) => candidate.id === target.itemId);
    if (item === undefined) return unresolved("item", `item "${target.itemId}" does not exist in view "${target.viewId}" of snapshot "${target.snapshotId}"`);
    const entity = entityOfItem(item);
    return {
      status: "resolved",
      snapshotId: target.snapshotId,
      viewId: target.viewId,
      itemId: target.itemId,
      viewDefinitionId: envelope.viewDefinitionId,
      ...(entity === undefined ? {} : { entity }),
    };
  }

  const entity = await session.getEntity(target.entity, target.snapshotId);
  if (!entity.ok) return unresolved("entity", `entity ${target.entity.repository}/${target.entity.kind}/${target.entity.id} does not exist in snapshot "${target.snapshotId}"`);
  const instances: Array<{ viewId: string; definitionId: string; completeness: Parameters<typeof rankViews>[0]["instances"][number]["completeness"] }> = [];
  for (const key of await session.listViews()) {
    if (key.snapshotId !== target.snapshotId) continue;
    const stored = await session.getView(key);
    if (!stored.ok) continue;
    const view = stored.value.envelope;
    if (view.entity.repository === target.entity.repository && view.entity.kind === target.entity.kind && view.entity.id === target.entity.id) {
      instances.push({ viewId: key.viewId, definitionId: view.viewDefinitionId, completeness: view.completeness });
    }
  }
  const { definitions } = await session.listDefinitions();
  const ranked = rankViews({
    entity: entity.value,
    definitions,
    instances: instances.map(({ definitionId, completeness }) => ({ definitionId, completeness })),
    ...(target.preferredViewDefinitionId === undefined ? {} : { preferredViewDefinitionId: target.preferredViewDefinitionId }),
  });
  const selected = ranked.selected;
  if (selected === null) return unresolved("view", `entity ${target.entity.id} has no available view in snapshot "${target.snapshotId}"`);
  const viewId = instances.filter((instance) => instance.definitionId === selected.definitionId).map((instance) => instance.viewId).sort(compareCodeUnits)[0];
  return {
    status: "resolved",
    snapshotId: target.snapshotId,
    entity: target.entity,
    viewDefinitionId: selected.definitionId,
    ...(viewId === undefined ? {} : { viewId }),
    ...(selected.fallbackFrom === undefined ? {} : { fallback: { requested: selected.fallbackFrom.requested, used: selected.definitionId, reason: selected.fallbackFrom.reason } }),
  };
}

export type SourceOpening =
  | {
      status: "resolved";
      repository: string;
      revision: string | null;
      path: string;
      highlight: [number, number];
      stored: { viewId: string; snapshotId: string; lines: NumberedLine[] };
      currency: { state: "fresh" | "stale" | "unknown"; recordedSha256: string | null; currentSha256: string | null };
    }
  | { status: "unresolved"; code: "UNRESOLVED_TARGET"; message: string };

const cannotOpen = (message: string): Extract<SourceOpening, { status: "unresolved" }> => ({ status: "unresolved", code: "UNRESOLVED_TARGET", message });

/** The lines [first, last] of a source view's stored excerpt, numbered by file line. */
function storedLines(source: { anchor: { lines: [number, number] }; text: string }, first: number, last: number): NumberedLine[] {
  const all = source.text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const offset = source.anchor.lines[0];
  return Array.from({ length: last - first + 1 }, (_, index) => ({ n: first + index, text: all[first - offset + index] ?? "" }));
}

/**
 * Opens the stored excerpt that covers the item's anchor (an item with an `anchor`, or a source
 * view's annotation). `currency` compares the recorded file hash with the registered root's bytes.
 */
export async function resolveItemSource(session: Session, key: ViewKey, itemId: string): Promise<SourceOpening> {
  const stored = await session.getView(key);
  if (!stored.ok) return cannotOpen(`view "${key.viewId}" does not exist in snapshot "${key.snapshotId}"`);
  const envelope = stored.value.envelope;
  const item = viewItems(envelope).find((candidate) => candidate.id === itemId);
  if (item === undefined) return cannotOpen(`item "${itemId}" does not exist in view "${key.viewId}"`);

  // what to open: (repository, path, first, last) and the source view holding the excerpt
  let anchor: { repository: string; path: string; lines: [number, number] } | undefined = item.anchor;
  let excerptView: { viewId: string; text: string; anchor: { repository: string; path: string; lines: [number, number] } } | undefined;
  if (envelope.component === "source") {
    const data = envelope.data as { excerpt: AnyItem & { text: string; anchor: NonNullable<AnyItem["anchor"]> } };
    excerptView = { viewId: key.viewId, text: data.excerpt.text, anchor: data.excerpt.anchor };
    anchor ??= item.id === data.excerpt.id ? data.excerpt.anchor : { repository: data.excerpt.anchor.repository, path: data.excerpt.anchor.path, lines: (item as unknown as { lines: [number, number] }).lines };
  }
  if (anchor === undefined) return cannotOpen(`item "${itemId}" has no source anchor to open`);
  if (excerptView === undefined) {
    for (const candidate of (await session.listViews()).filter((other) => other.snapshotId === key.snapshotId)) {
      const other = await session.getView(candidate);
      if (!other.ok || other.value.envelope.component !== "source") continue;
      const data = other.value.envelope.data as { excerpt: { text: string; anchor: { repository: string; path: string; lines: [number, number] } } };
      const covered = data.excerpt.anchor.repository === anchor.repository && data.excerpt.anchor.path === anchor.path && data.excerpt.anchor.lines[0] <= anchor.lines[0] && anchor.lines[1] <= data.excerpt.anchor.lines[1];
      if (covered) { excerptView = { viewId: candidate.viewId, text: data.excerpt.text, anchor: data.excerpt.anchor }; break; }
    }
  }
  if (excerptView === undefined) return cannotOpen(`item "${itemId}" is anchored at ${anchor.path}:${anchor.lines[0]}-${anchor.lines[1]}, which no stored source excerpt of snapshot "${key.snapshotId}" covers`);

  const repository = envelope.freshness.repositories.find((candidate) => candidate.id === anchor.repository);
  const recordedSha256 = repository?.files[anchor.path] ?? null;
  const current = await currentFileHash(await session.repositories(), anchor.repository, anchor.path);
  const currentSha256 = current.state === "present" ? current.sha256 : null;
  const state: "fresh" | "stale" | "unknown" = current.state !== "present" ? "unknown" : currentSha256 !== null && currentSha256 === recordedSha256 ? "fresh" : "stale";
  return {
    status: "resolved",
    repository: anchor.repository,
    revision: repository?.gitRev ?? null,
    path: anchor.path,
    highlight: [anchor.lines[0], anchor.lines[1]],
    stored: { viewId: excerptView.viewId, snapshotId: key.snapshotId, lines: storedLines(excerptView, anchor.lines[0], anchor.lines[1]) },
    currency: { state, recordedSha256, currentSha256 },
  };
}

/** S11: evidence cites a declared source of the claim's view as well as items of views. */
export type SourceTarget = { snapshotId: string; viewId: string; sourceId: string };
export type SourceResolution =
  | { status: "resolved"; sourceId: string; source: Source }
  | { status: "unresolved"; code: "UNRESOLVED_TARGET"; missing: "source"; message: string };
export type EvidenceStep =
  | { relation: "supports" | "contradicts"; target: LinkTarget; resolution: LinkResolution }
  | { relation: "supports" | "contradicts"; target: SourceTarget; resolution: SourceResolution };

/**
 * Resolves every supports/contradicts target of a notebook claim block, in declared order (source ids and
 * `{viewId,itemId}` targets interleaved exactly as the claim lists them; supports first, then contradicts).
 */
export async function resolveClaimEvidence(session: Session, key: ViewKey, claimBlockId: string): Promise<EvidenceStep[]> {
  const stored = await session.getView(key);
  if (!stored.ok || stored.value.envelope.component !== "notebook") return [];
  const envelope = stored.value.envelope;
  const claim = (envelope.data as { blocks: Array<AnyItem & { kind: string; supports?: unknown[]; contradicts?: unknown[] }> }).blocks.find((block) => block.id === claimBlockId && block.kind === "claim");
  if (claim === undefined) return [];
  const steps: EvidenceStep[] = [];
  for (const relation of ["supports", "contradicts"] as const) {
    for (const target of claim[relation] ?? []) {
      if (typeof target === "string") {
        const source = envelope.sources.find((candidate) => candidate.id === target);
        steps.push({
          relation,
          target: { snapshotId: key.snapshotId, viewId: key.viewId, sourceId: target },
          resolution: source === undefined
            ? { status: "unresolved", code: "UNRESOLVED_TARGET", missing: "source", message: `source "${target}" is not declared by view "${key.viewId}"` }
            : { status: "resolved", sourceId: target, source },
        });
      } else {
        const { viewId, itemId } = target as { viewId: string; itemId: string };
        const linkTarget = { snapshotId: key.snapshotId, viewId, itemId };
        steps.push({ relation, target: linkTarget, resolution: await resolveLink(session, linkTarget) });
      }
    }
  }
  return steps;
}
