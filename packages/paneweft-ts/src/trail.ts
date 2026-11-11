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
  links?: Array<{ kind: "type" | "view" | "example" | "source"; id: string; snapshotId: string }>;
  supersedes?: string;
  deadEndExample?: string;
}

export class TrailBuilder {
  constructor(readonly id: string, readonly title: string) {}
  entry(entry: TrailEntrySpec): this {
    return this;
  }
  /** `paneweft.trail/1`. STUB: null. */
  toJSON(): Json {
    return null;
  }
}
export function trail(id: string, title: string): TrailBuilder {
  return new TrailBuilder(id, title);
}
