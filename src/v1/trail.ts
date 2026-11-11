// Decision trails (spec amendment S8): validation and lowering to existing notebook blocks.
import type { Result } from "../core/errors.ts";
import type { Trail } from "../generated/v1/Trail.ts";
import { notImplemented } from "./stub.ts";

export interface TrailContext {
  /** Source id (in the lowered view's `sources`) of the trail document itself. */
  trailSourceId: string;
  /** Maps an option's evidence `source` string to a source id of the lowered view. */
  sourceIds: Record<string, string>;
  /** Example ids that exist; a `deadEndExample` outside it is a DANGLING_REFERENCE. */
  knownExamples?: string[];
}

/** Rules: entry orders strictly increase; option ids are unique per entry; at most one chosen option; a superseded option names
 * `supersededBy`; `supersedes` names an EARLIER entry and chains do not cycle; a dead-end example must exist. STUB. */
export function validateTrail(trail: unknown, context: Pick<TrailContext, "knownExamples">): Result<Trail> {
  return notImplemented("validateTrail");
}

/** The notebook component data of a trail, in entry order, deterministic (docs/v1-red-contract.md section 13). STUB. */
export function lowerTrail(trail: Trail, context: TrailContext): Result<{ blocks: Array<Record<string, unknown>> }> {
  return notImplemented("lowerTrail");
}
