// Envelope-level wire types.
// CLAIM(single-wire-source): `Envelope` is the declaration GENERATED from the canonical JSON Schemas
//   (npm run gen:types, committed in src/generated, checked for staleness by src/schemas/types.test.ts), so the
//   component discrimination (data follows `component`) and the exclusion of data for unsupported views come from the
//   schema's own conditionals and are enforced by the compiler [design section 5; S10; N4].
// Ajv plus the semantic validator still own constraints a static declaration cannot express (references, ranges, cycles).
// The remaining shapes below are small value types the schemas also state; Source is the generated element type.
import type { Envelope as GeneratedEnvelope } from "../generated/index.ts";
import type { EnvelopeMetadata } from "../generated/EnvelopeMetadata.ts";

export type Envelope = GeneratedEnvelope;
export type Source = EnvelopeMetadata["sources"][number];
export type Component = Envelope["component"];
export type Completeness = Envelope["completeness"];
export type RepositoryFreshness = EnvelopeMetadata["freshness"]["repositories"][number];
export type ViewLink = EnvelopeMetadata["links"][number];

export type Provenance = "read" | "parsed" | "compiled" | "observed" | "inferred";
export type Scalar = string | number | boolean | null;
export interface Anchor { repository: string; path: string; lines: [number, number] }
export interface EntityRef { repository: string; id: string; kind: string }

export interface Entity extends EntityRef {
  snapshotId: string; label: string; dataRoles: string[]; relations: Array<{ name: string; target: EntityRef }>;
}
export interface ViewDefinition {
  id: string; entityKind: string; title: string; priority?: number; component: Component;
  requires: string[]; dataRole: string; forward?: { entityId: string; viewDefinitionId: string };
}
export interface Bundle {
  schemaVersion: "paneweft.bundle/1"; entities: Entity[]; definitions: ViewDefinition[]; views: Envelope[];
}
