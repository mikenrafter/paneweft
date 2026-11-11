// Decision trails (spec amendment S8): validation and lowering to existing notebook blocks.
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import type { Trail } from "../generated/v1/Trail.ts";
import { validateAgainstV1 } from "./schemas.ts";

export interface TrailContext {
  /** Source id (in the lowered view's `sources`) of the trail document itself. */
  trailSourceId: string;
  /** Maps an option's evidence `source` string to a source id of the lowered view. */
  sourceIds: Record<string, string>;
  /** Example ids that exist; a `deadEndExample` outside it is a DANGLING_REFERENCE. */
  knownExamples?: string[];
}

const issue = (code: ValidationIssue["code"], pointer: string, constraint: string, hint: string): ValidationIssue => ({ code, pointer, constraint, hint });

/** Rules: entry orders strictly increase; option ids are unique per entry; at most one chosen option; a superseded option names
 * `supersededBy`; `supersedes` names an EARLIER entry and chains do not cycle; a dead-end example must exist. */
export function validateTrail(trail: unknown, context: Pick<TrailContext, "knownExamples">): Result<Trail> {
  const shape = validateAgainstV1("urn:paneweft:schema:v1:trail:1", trail);
  if (shape.length > 0) return err("VALIDATION_FAILED", `the trail does not match paneweft.trail/1 (${shape.length} fault${shape.length === 1 ? "" : "s"})`, { errors: shape });
  const document = trail as Trail;
  const issues: ValidationIssue[] = [];
  const position = new Map<string, number>();
  document.entries.forEach((entry, index) => {
    if (position.has(entry.id)) issues.push(issue("DUPLICATE_ID", `/entries/${index}/id`, "entry ids are unique", `The entry id "${entry.id}" appears twice.`));
    position.set(entry.id, index);
    const previous = document.entries[index - 1];
    if (previous !== undefined && entry.order <= previous.order) issues.push(issue("OUT_OF_RANGE", `/entries/${index}/order`, `order > ${previous.order}`, "Entry orders strictly increase; renumber the entries."));
    const options = new Set<string>();
    let chosen = 0;
    entry.options.forEach((option, optionIndex) => {
      if (options.has(option.id)) issues.push(issue("DUPLICATE_ID", `/entries/${index}/options/${optionIndex}/id`, "option ids are unique within an entry", `The option id "${option.id}" appears twice.`));
      options.add(option.id);
      if (option.status === "chosen") {
        chosen += 1;
        if (chosen > 1) issues.push(issue("CONSTRAINT", `/entries/${index}/options/${optionIndex}/status`, "at most one chosen option per entry", "Mark the others abandoned, failed or superseded."));
      }
      if (option.status === "superseded" && option.supersededBy === undefined) issues.push(issue("REQUIRED", `/entries/${index}/options/${optionIndex}/supersededBy`, "a superseded option names its successor", "Name the option that replaced it."));
    });
    if (entry.deadEndExample !== undefined && context.knownExamples !== undefined && !context.knownExamples.includes(entry.deadEndExample)) {
      issues.push(issue("DANGLING_REFERENCE", `/entries/${index}/deadEndExample`, "a dead end names an example that exists", `No example "${entry.deadEndExample}" is declared; a dead end keeps a runnable example that reproduces its failure.`));
    }
  });
  document.entries.forEach((entry, index) => {
    if (entry.supersedes === undefined) return;
    const target = position.get(entry.supersedes);
    if (target === undefined) issues.push(issue("DANGLING_REFERENCE", `/entries/${index}/supersedes`, "supersession names an entry of this trail", `No entry "${entry.supersedes}".`));
    else if (target >= index) issues.push(issue("CONSTRAINT", `/entries/${index}/supersedes`, "supersession names an EARLIER entry", "Supersession is explicit and points backwards; chains cannot cycle."));
  });
  return issues.length > 0 ? err("VALIDATION_FAILED", `the trail is not valid (${issues.length} fault${issues.length === 1 ? "" : "s"})`, { errors: issues }) : ok(document);
}

/** The notebook component data of a trail, in entry order, deterministic (docs/v1-red-contract.md section 13). */
export function lowerTrail(trail: Trail, context: TrailContext): Result<{ blocks: Array<Record<string, unknown>> }> {
  const blocks: Array<Record<string, unknown>> = [];
  const base = { provenance: "read" as const };
  const trailEvidence = [context.trailSourceId];
  for (const [entryIndex, entry] of trail.entries.entries()) {
    blocks.push({ id: `${entry.id}-question`, kind: "prose", markdown: `**${entry.question}**`, ...base, evidence: trailEvidence });
    for (const [optionIndex, option] of entry.options.entries()) {
      const supports: string[] = [];
      for (const [evidenceIndex, evidence] of option.evidence.entries()) {
        const mapped = context.sourceIds[evidence.source];
        if (mapped === undefined) return err("VALIDATION_FAILED", `the evidence "${evidence.source}" of option ${option.id} is not a source of the lowered view`, { errors: [issue("DANGLING_REFERENCE", `/entries/${entryIndex}/options/${optionIndex}/evidence/${evidenceIndex}/source`, "evidence names a registered source", "Add the source to the view or drop the evidence.")] });
        if (!supports.includes(mapped)) supports.push(mapped);
      }
      blocks.push({ id: `${entry.id}-option-${option.id}`, kind: "claim", statement: `[${option.status}] ${option.id}: ${option.reason}`, status: supports.length > 0 ? "supported" : "open", supports, contradicts: [], ...base, evidence: supports.length > 0 ? supports : trailEvidence });
    }
    const successor = trail.entries.slice(entryIndex + 1).find((later) => later.supersedes === entry.id);
    blocks.push({ id: `${entry.id}-decision`, kind: "prose", markdown: `**Decision:** ${entry.decision}${successor === undefined ? "" : ` (superseded by ${successor.id})`}`, ...base, evidence: trailEvidence });
    if (entry.deadEndExample !== undefined) blocks.push({ id: `${entry.id}-dead-end`, kind: "example", exampleId: entry.deadEndExample, ...base, evidence: trailEvidence });
  }
  return ok({ blocks });
}
