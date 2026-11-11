// Decision trails declared in code (spec amendment S8). Produces paneweft.trail/1.
import type { Json } from "./types.ts";

export type OptionStatus = "chosen" | "abandoned" | "superseded" | "failed";
export interface TrailOptionSpec {
  id: string;
  status: OptionStatus;
  reason: string;
  evidence?: Array<{ provenance: "read" | "parsed" | "compiled" | "observed" | "inferred"; source: string; reason?: string }>;
  supersededBy?: string;
}
export interface TrailEntrySpec {
  id: string;
  order: number;
  question: string;
  options: TrailOptionSpec[];
  decision: string;
  /** Snapshot-bound links to a type, view, example or source; a source link may carry the anchor it points at. */
  links?: Array<{ kind: "type" | "view" | "example" | "source"; id: string; snapshotId: string; anchor?: { repository: string; path: string; lines: [number, number] } }>;
  supersedes?: string;
  deadEndExample?: string;
}

export class TrailBuilder {
  private readonly entries: TrailEntrySpec[] = [];
  constructor(readonly id: string, readonly title: string) {}
  entry(entry: TrailEntrySpec): this {
    this.entries.push(entry);
    return this;
  }
  /** `paneweft.trail/1`. Defaults: empty evidence and links; `supersedes`, `supersededBy` and `deadEndExample` only when set. */
  toJSON(): Json {
    const entries = this.entries.map((entry): Json => {
      const options = entry.options.map((option): Json => ({
        id: option.id,
        status: option.status,
        reason: option.reason,
        evidence: (option.evidence ?? []) as Json,
        ...(option.supersededBy === undefined ? {} : { supersededBy: option.supersededBy }),
      }));
      return {
        id: entry.id,
        order: entry.order,
        question: entry.question,
        options,
        decision: entry.decision,
        links: (entry.links ?? []) as Json,
        ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
        ...(entry.deadEndExample === undefined ? {} : { deadEndExample: entry.deadEndExample }),
      };
    });
    return { schemaVersion: "paneweft.trail/1", id: this.id, title: this.title, entries };
  }
}
export function trail(id: string, title: string): TrailBuilder {
  return new TrailBuilder(id, title);
}
