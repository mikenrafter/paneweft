// The one freshness answer of a collected snapshot (F23). A run records the fingerprint of the inputs it was collected from (a sample of file
// hashes); the answer compares it with the files of the repository now, so a result is stale when an input was edited, added or removed, never
// merely because its catalogue was compiled again. `view_result`, `inspect_view`, `open_entity`, `navigate` and the viewer all end here, so they
// cannot disagree about the same snapshot. Reads only under the root the owner registered.
import { join } from "node:path";
import type { FreshnessResult, UnverifiedRepository } from "../core/freshness.ts";
import type { SessionReader } from "../core/session.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import type { AdapterRecord } from "./adapters.ts";
import { compareFingerprints, computeFingerprint, type Fingerprint } from "./fingerprint.ts";
import { committedImport, readJsonFile, runDirectory } from "./read.ts";

export interface Freshness { status: "fresh" | "stale" | "unverified" | "not-applicable"; reasons?: string[]; catalogueDigest?: string; scope?: string }
export type Consistency = "consistent-sampled" | "mixed-input" | "unverified";

/** The v1 answer and the facts the v0 shape needs beside it. */
export interface Judgement {
  freshness: Freshness;
  changes: Array<{ path: string; change: "added" | "modified" | "deleted"; recordedSha256: string | null; currentSha256: string | null }>;
  unverified: Array<{ code: UnverifiedRepository["code"]; reason: string }>;
}

export async function adaptersOf(sessionDir: string): Promise<AdapterRecord[]> {
  // imported when needed: adapters.ts resolves a script path from import.meta.url as it loads, which the DOM test environment of the viewer suites cannot do
  const { loadAdapters } = await import("./adapters.ts");
  const loaded = await loadAdapters(sessionDir);
  return loaded.ok ? loaded.value : [];
}

/** Freshness of a fingerprint against the real files of the registered repository, never a guess: stale names the changed paths. */
export async function judgeFreshness(context: { session: Pick<SessionReader, "repositories">; sessionDir: string }, repo: string, adapterId: string | undefined, captured: Fingerprint | undefined, digest?: string, consistency?: Consistency): Promise<Judgement> {
  const base = digest === undefined ? {} : { catalogueDigest: digest };
  const unverified = (code: UnverifiedRepository["code"], reason: string): Judgement => ({ freshness: { status: "unverified", reasons: [reason], ...base }, changes: [], unverified: [{ code, reason }] });
  const registered = (await context.session.repositories()).find((candidate) => candidate.id === repo);
  if (registered === undefined) return unverified("REPOSITORY_NOT_REGISTERED", `the root of repository "${repo}" is not registered, so its files cannot be compared: run \`paneweft repo add --repo ${repo} --root <dir>\``);
  if (captured === undefined || captured.members.length === 0) return unverified("FINGERPRINT_UNAVAILABLE", "no input fingerprint was recorded for this result");
  const adapter = (await adaptersOf(context.sessionDir)).find((candidate) => candidate.repo === repo && (adapterId === undefined || candidate.id === adapterId));
  const root = adapter === undefined ? registered.root : join(adapter.workspaceRoot, adapter.entry);
  const current = await computeFingerprint({ root, declaredExtras: captured.declaredExtras ?? [], exclusions: captured.exclusions ?? [] });
  if (!current.ok) return unverified("FINGERPRINT_UNAVAILABLE", current.error.message);
  const verdict = compareFingerprints(captured, current.value);
  if (verdict.status !== "fresh") {
    const was = new Map(captured.members.map((member) => [member.path, member.sha256]));
    const now = new Map(current.value.members.map((member) => [member.path, member.sha256]));
    return {
      freshness: { status: "stale", reasons: verdict.reasons.map((reason) => `${reason.path}: ${reason.change}`), ...base },
      changes: verdict.reasons.map((reason) => ({ path: reason.path, change: reason.change, recordedSha256: was.get(reason.path) ?? null, currentSha256: now.get(reason.path) ?? null })),
      unverified: [],
    };
  }
  // S14: the sources match the recorded sample, but a recorded doubt about the sample caps the answer. An edit made during the run and restored
  // afterwards compares equal; "fresh" would be a claim the evidence cannot carry.
  if (consistency === "mixed-input") return unverified("INPUT_UNSTABLE", "the recorded input sample was mixed: the checkout changed while this result was being produced, so matching sources do not show it was stable then");
  if (consistency === "unverified") return unverified("INPUT_UNSTABLE", "the input of this result was never sampled twice, so its consistency is unverified");
  return { freshness: { status: "fresh", ...base }, changes: [], unverified: [] };
}

export async function freshnessOf(context: { session: Pick<SessionReader, "repositories">; sessionDir: string }, repo: string, adapterId: string | undefined, captured: Fingerprint | undefined, digest?: string, consistency?: Consistency): Promise<Freshness> {
  return (await judgeFreshness(context, repo, adapterId, captured, digest, consistency)).freshness;
}

/** The judgement of a stored run: its recorded fingerprint against the repository it was collected from, through the adapter that collected it. */
export async function judgeRun(context: { session: Pick<SessionReader, "repositories">; sessionDir: string }, repo: string, run: TestRun): Promise<Judgement> {
  const adapter = (await adaptersOf(context.sessionDir)).find((candidate) => candidate.repo === repo && candidate.kind === run.runner.id);
  return judgeFreshness(context, repo, adapter?.id, { digest: run.inputFingerprint.digest, members: run.inputFingerprint.members ?? [], declaredExtras: [], exclusions: [] }, undefined, run.inputFingerprint.sampledConsistency);
}

/** The v0 shape of a judgement, for the surfaces that print a `FreshnessResult`. */
export function asFreshnessResult(repo: string, judgement: Judgement): FreshnessResult {
  switch (judgement.freshness.status) {
    case "fresh": return { status: "fresh" };
    case "stale": return { status: "stale", changedPaths: judgement.changes.map((change) => ({ repository: repo, ...change })), inaccessibleRoots: [] };
    default: return { status: "unverified", unverified: judgement.unverified.map((entry) => ({ repository: repo, ...entry })) };
  }
}

/** The freshness answer of `snapshotId` when it is a collected run's snapshot, else undefined (the snapshot is judged by its own source anchors). */
export async function collectedFreshness(session: SessionReader, snapshotId: string): Promise<FreshnessResult | undefined> {
  if (!snapshotId.startsWith("snap-") || snapshotId.length <= 5) return undefined;
  const runId = snapshotId.slice(5);
  const record = await committedImport(session, runId);
  if (record === undefined) return undefined;
  const run = await readJsonFile<TestRun>(join(runDirectory(session, runId), "run.json"));
  if (run === undefined) return undefined;
  return asFreshnessResult(record.repo, await judgeRun({ session, sessionDir: session.dir }, record.repo, run));
}
