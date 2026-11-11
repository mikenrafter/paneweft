// Envelope-level wire types, hand-written for the red phase.
// S10: npm run gen:types produces schema-derived declarations in src/generated.
// TODO(green): use the generated Envelope at this public boundary. The compiler
// consumer test in src/schemas/types.test.ts stays red until that wiring exists.
// This compile-only stub keeps data unknown; schemas win on any disagreement.

export type Provenance = "read" | "parsed" | "compiled" | "observed" | "inferred";
export type Scalar = string | number | boolean | null;
export interface Anchor { repository: string; path: string; lines: [number, number] }
export interface EntityRef { repository: string; id: string; kind: string }
export interface CapturedSource {
  id: string; kind: "file" | "command" | "log" | "document"; repository?: string; path?: string; url?: string;
  sha256: string; capturedAt: string; method: string; runId?: string; argv?: string[]; exitCode?: number;
}
/** S4: one execution of an owner-configured runner; makes example evidence honestly `observed`. */
export interface RunSource { id: string; kind: "run"; run_id: string; runner_id: string; started_at: string; finished_at?: string }
/** S4: the compiler or language service behind `compiled` facts. */
export interface ToolSource { id: string; kind: "tool"; name: string; version: string }
export type Source = CapturedSource | RunSource | ToolSource;
export type Completeness =
  | { status: "complete"; criterion: string }
  | { status: "partial"; gaps: Array<{ id: string; question: string; reason: string }> }
  | { status: "unsupported"; reason: string; missingCapabilities: string[] };
export interface RepositoryFreshness {
  id: string; root: string; gitRev: string | null; dirty: boolean; files: Record<string, string>;
}
export interface ViewLink {
  id: string; relation: string; snapshotId: string; viewId: string; itemId?: string; entity?: EntityRef;
}
export interface Envelope {
  schemaVersion: "paneweft.view/1";
  id: string; title: string; question: string; entity: EntityRef; snapshotId: string;
  component: "list" | "tree" | "graph" | "source" | "shape" | "notebook" | "example";
  viewDefinitionId: string;
  scope: { repositories: string[]; roots: string[]; excludes: string[]; relation?: string; limits: string[] };
  sources: Source[]; generatedAt: string; freshness: { repositories: RepositoryFreshness[] };
  links: ViewLink[]; completeness: Completeness; data?: unknown;
}
export interface Entity extends EntityRef {
  snapshotId: string; label: string; dataRoles: string[]; relations: Array<{ name: string; target: EntityRef }>;
}
export interface ViewDefinition {
  id: string; entityKind: string; title: string; priority?: number; component: Envelope["component"];
  requires: string[]; dataRole: string; forward?: { entityId: string; viewDefinitionId: string };
}
export interface Bundle {
  schemaVersion: "paneweft.bundle/1"; entities: Entity[]; definitions: ViewDefinition[]; views: Envelope[];
}
