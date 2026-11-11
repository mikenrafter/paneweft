// The example view a reader sees: the envelope's own runs PLUS the runs recorded on it (review S8).
//
// Reason: `example_record` and `example run` store a run output beside the view, but the envelope is immutable, so every reader that looked only at
// `envelope.data.runs` (inspect, summaries, the viewer) kept saying "not run". `readEffectiveView` is the one place that merges them, so the agent and
// the browser cannot disagree about which runs an example has.
// CLAIM(recorded-runs-visible): the effective example envelope lists every envelope run and every recorded run whose merge validates, in that order
//   (envelope first, then recording order), each with its provenance and assertions; a recorded run is identified in `RecordedRuns` by its run item id
//   [example.recorded-runs.test.ts, review S8].
// CLAIM(derived-valid): the merged envelope is itself a valid `paneweft.view/1` (validateSubmission), because runs are merged one at a time and a run
//   that would break validity is left out and named in `notice`, never merged half-way. Item ids share one namespace per view, so a recorded id that
//   collides is made unique as `<runId>/<id>`; a recorded source that collides with a different source is renamed `<runId>:<id>`. Every reference the run
//   carries (evidence and basis) follows those renamings [example-runs.references.test.ts, review round 2 S11].
// Errors: a read failure of the stored view is returned as is; a failure to read a recorded output degrades to the plain envelope plus a notice.
// Mating parts: summaries.ts (RecordedRuns), viewer/session-source.ts (ViewModel.recordedRuns), operations.ts loadView.
import type { Envelope, Source } from "./wire.ts";
import type { Result } from "./errors.ts";
import type { SessionReader, StoredView, ViewKey } from "./session.ts";
import type { RecordedRuns } from "./summaries.ts";
import { canonicalJson } from "./canonical.ts";
import { viewItems } from "./items.ts";
import { validateSubmission } from "./validate.ts";

type Json = any;

export interface EffectiveView { stored: StoredView; envelope: Envelope; recorded: RecordedRuns | undefined }

/** Merges `outputs` (stored paneweft.run/1 documents, in recording order) into an example envelope. Pure. */
export function deriveExampleEnvelope(envelope: Envelope, outputs: Array<{ contentHash: string; output: Json }>): { envelope: Envelope; recorded: RecordedRuns } {
  const byItemId = new Map<string, { runId: string; contentHash: string }>();
  const skipped: string[] = [];
  let current = envelope;
  for (const { contentHash, output } of outputs) {
    const run = output?.run;
    const data = current.data as Json;
    if (typeof run?.runId !== "string" || data === undefined) continue;
    if ((data.runs as Json[]).some((existing) => existing.runId === run.runId)) continue; // already shown (an envelope run wins)
    const merged = withRun(current, output, contentHash);
    const check = validateSubmission(merged.envelope);
    if (!check.ok) { skipped.push(`${run.runId} (${check.errors[0]?.code} at ${check.errors[0]?.pointer})`); continue; }
    current = merged.envelope;
    byItemId.set(merged.runItemId, { runId: run.runId, contentHash });
  }
  return {
    envelope: current,
    recorded: { byItemId, notice: skipped.length === 0 ? null : `recorded runs left out because they do not fit this view: ${skipped.join(", ")}` },
  };
}

/**
 * `envelope` with one recorded run appended. Not validated here.
 * Two phases, so that no reference can be rewritten against a half-built mapping (review round 2, S11):
 *   1. ALLOCATE: the new id of every item the run owns (its own id and its assertions') and the final id of every source it cites (declared into the view
 *      when new, renamed when the view already has a different source of that id);
 *   2. REWRITE: every reference the run carries, through those mappings: `evidence` (source ids) and `basis` (ids of the run's own items, else of sources).
 * A run output is validated on its own, so a basis id can only mean one of the run's own items (which wins over a source of the same id) or a source;
 * ids that name neither are left as they are for the validator to report. The run's other members hold no ids of this view (`result` names an entity).
 */
function withRun(envelope: Envelope, output: Json, contentHash: string): { envelope: Envelope; runItemId: string } {
  const runId = output.run.runId as string;
  const run = structuredClone(output.run) as Json;
  const owned: Json[] = [run, ...(run.assertions ?? [])];

  // 1a. item ids: one namespace per view
  const taken = new Set(viewItems(envelope).map((item) => item.id));
  const itemIds = new Map<string, string>();
  for (const item of owned) {
    if (itemIds.has(item.id)) continue;
    let candidate = taken.has(item.id) ? `${runId}/${item.id}` : item.id;
    for (let counter = 2; taken.has(candidate); counter += 1) candidate = `${runId}/${item.id}#${counter}`;
    taken.add(candidate);
    itemIds.set(item.id, candidate);
  }

  // 1b. sources: every id cited by evidence, or by a basis that is not one of the run's own items, in citation order
  const offered = new Map<string, Source>();
  for (const source of [...((output.sources as Source[] | undefined) ?? []), ...(((output.bundle?.views as Json[] | undefined) ?? []).flatMap((view) => (view.sources as Source[]) ?? []))]) offered.set(source.id, source);
  const cited = new Set<string>();
  for (const item of owned) {
    for (const id of (item.evidence as string[] | undefined) ?? []) cited.add(id);
    for (const id of (item.basis as string[] | undefined) ?? []) if (!itemIds.has(id)) cited.add(id);
  }
  const sources = [...envelope.sources];
  const sourceIds = new Map<string, string>();
  for (const id of cited) {
    const existing = sources.find((source) => source.id === id);
    const wanted = offered.get(id);
    if (existing === undefined) {
      if (wanted !== undefined) sources.push(wanted);
      sourceIds.set(id, id);
    } else if (wanted === undefined || canonicalJson(existing) === canonicalJson(wanted)) {
      sourceIds.set(id, id);
    } else {
      let fresh = `${runId}:${id}`;
      for (let counter = 2; sources.some((source) => source.id === fresh); counter += 1) fresh = `${runId}:${id}#${counter}`;
      sources.push({ ...wanted, id: fresh });
      sourceIds.set(id, fresh);
    }
  }

  // 2. rewrite
  const rewrite = (item: Json): void => {
    item.id = itemIds.get(item.id) as string;
    item.evidence = ((item.evidence as string[] | undefined) ?? []).map((id) => sourceIds.get(id) ?? id);
    if (item.basis !== undefined) item.basis = (item.basis as string[]).map((id) => itemIds.get(id) ?? sourceIds.get(id) ?? id);
  };
  const originalIds = owned.map((item) => item.id as string);
  for (const item of owned) rewrite(item);
  const data = envelope.data as Json;
  return { envelope: { ...envelope, sources, data: { ...data, runs: [...data.runs, run] } } as Envelope, runItemId: itemIds.get(originalIds[0] as string) as string };
}

/** The stored view of `key`, and for an example view its effective envelope (see the header). Other components pass through untouched. */
export async function readEffectiveView(session: SessionReader, key: ViewKey): Promise<Result<EffectiveView>> {
  const stored = await session.getView(key);
  if (!stored.ok) return stored;
  const base = stored.value.envelope;
  if (base.component !== "example") return { ok: true, value: { stored: stored.value, envelope: base, recorded: undefined } };
  const outputs = await session.recordedRunOutputs(key);
  if (!outputs.ok) {
    return { ok: true, value: { stored: stored.value, envelope: base, recorded: { byItemId: new Map(), notice: `recorded runs could not be read: ${outputs.error.message}` } } };
  }
  if (outputs.value.length === 0) return { ok: true, value: { stored: stored.value, envelope: base, recorded: undefined } };
  const derived = deriveExampleEnvelope(base, outputs.value.map(({ run, output }) => ({ contentHash: run.contentHash, output })));
  return { ok: true, value: { stored: stored.value, envelope: derived.envelope, recorded: derived.recorded } };
}
