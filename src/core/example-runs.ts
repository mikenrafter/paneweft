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
//   collides is made unique as `<runId>/<id>`; a recorded source that collides with a different source is renamed `<runId>:<id>`.
// Errors: a read failure of the stored view is returned as is; a failure to read a recorded output degrades to the plain envelope plus a notice.
// Mating parts: summaries.ts (RecordedRuns), viewer/session-source.ts (ViewModel.recordedRuns), operations.ts loadView.
import type { Envelope, Source } from "./wire.ts";
import type { Result } from "./errors.ts";
import type { Session, StoredView, ViewKey } from "./session.ts";
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

/** `envelope` with one recorded run appended (ids and sources made unique, evidence rewritten to match). Not validated here. */
function withRun(envelope: Envelope, output: Json, contentHash: string): { envelope: Envelope; runItemId: string } {
  const runId = output.run.runId as string;
  const used = new Set(viewItems(envelope).map((item) => item.id));
  const unique = (id: string): string => {
    let candidate = used.has(id) ? `${runId}/${id}` : id;
    for (let counter = 2; used.has(candidate); counter += 1) candidate = `${runId}/${id}#${counter}`;
    used.add(candidate);
    return candidate;
  };
  // sources the run's evidence cites: its own, those of the output's bundle views, and the view's (already present)
  const offered = new Map<string, Source>();
  for (const source of [...((output.sources as Source[] | undefined) ?? []), ...(((output.bundle?.views as Json[] | undefined) ?? []).flatMap((view) => (view.sources as Source[]) ?? []))]) offered.set(source.id, source);
  const sources = [...envelope.sources];
  const renamed = new Map<string, string>();
  const evidenceOf = (ids: string[]): string[] => ids.map((id) => {
    const known = renamed.get(id);
    if (known !== undefined) return known;
    const existing = sources.find((source) => source.id === id);
    const wanted = offered.get(id);
    if (existing === undefined) {
      if (wanted !== undefined) sources.push(wanted);
      return id;
    }
    if (wanted === undefined || canonicalJson(existing) === canonicalJson(wanted)) return id;
    const fresh = `${runId}:${id}`;
    renamed.set(id, fresh);
    sources.push({ ...wanted, id: fresh });
    return fresh;
  });
  const run = structuredClone(output.run) as Json;
  const runItemId = unique(run.id);
  run.id = runItemId;
  run.evidence = evidenceOf(run.evidence ?? []);
  run.assertions = (run.assertions ?? []).map((assertion: Json) => ({ ...assertion, id: unique(assertion.id), evidence: evidenceOf(assertion.evidence ?? []) }));
  const data = envelope.data as Json;
  return { envelope: { ...envelope, sources, data: { ...data, runs: [...data.runs, run] } } as Envelope, runItemId };
}

/** The stored view of `key`, and for an example view its effective envelope (see the header). Other components pass through untouched. */
export async function readEffectiveView(session: Session, key: ViewKey): Promise<Result<EffectiveView>> {
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
