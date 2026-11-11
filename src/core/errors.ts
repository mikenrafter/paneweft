// The error model shared by core, CLI, MCP and viewer (design section 4):
// `{code, message, errors: [{pointer, constraint, hint}], retryable}`.
// This repo adds a fine-grained `code` to each issue (see docs/red-contract.md).

export const ISSUE_CODES = [
  // shape (Ajv)
  "REQUIRED", "TYPE", "ENUM", "SCHEMA_VERSION", "UNKNOWN_COMPONENT", "UNKNOWN_PROPERTY", "FORBIDDEN_PROPERTY",
  "PATTERN", "OUT_OF_RANGE", "SIZE", "CONSTRAINT",
  // semantic
  "DUPLICATE_ID", "DANGLING_REFERENCE", "INVALID_LINE_RANGE", "ANNOTATION_OUTSIDE_EXCERPT", "TREE_CYCLE",
  "ALIAS_CYCLE", "PATH_DISCONTINUOUS", "PROVENANCE_RUN_REQUIRED", "PASSED_WITH_FAILED_ASSERTION",
  // round 2: S4 compiled facts need a tool source, S8 definition metadata and conflicting identities
  "PROVENANCE_TOOL_REQUIRED", "DEFINITION_MISMATCH", "IDENTITY_CONFLICT",
  // limits
  "LIMIT_EXCEEDED",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export const OPERATION_ERROR_CODES = [
  "VALIDATION_FAILED", "INVALID_ARGUMENT", "UNKNOWN_OPERATION", "BUDGET_TOO_SMALL", "CURSOR_INVALID",
  "CURSOR_MISMATCH", "CONFLICT", "NOT_FOUND", "UNRESOLVED_TARGET", "SESSION_REQUIRED", "PATH_OUTSIDE_ROOT",
  "REPOSITORY_NOT_REGISTERED", "INVALID_PATH", "LINES_OUT_OF_RANGE", "SNAPSHOT_CONFLICT", "STORAGE_FAILED",
  "STORAGE_CORRUPT", "RUNNER_NOT_FOUND", "RUNNER_TIMEOUT", "RUNNER_OUTPUT_INVALID", "RUNNER_FAILED",
  "DUPLICATE_RUN", "NON_LOOPBACK_HOST", "FORBIDDEN_ORIGIN", "UNAUTHORIZED", "NO_SUCH_PANE", "INTERNAL",
  // Present only in stubs. Green phase deletes every use; `grep -r NOT_IMPLEMENTED src` must be empty.
  "NOT_IMPLEMENTED",
] as const;
export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];

export interface ValidationIssue {
  readonly code: IssueCode;
  /** RFC 6901 JSON pointer into the submitted document; "" is the document root. */
  readonly pointer: string;
  /** What the schema or rule required, e.g. "type: integer". */
  readonly constraint: string;
  /** A repair hint an agent can act on. */
  readonly hint: string;
}

export interface OperationError {
  readonly schemaVersion: "paneweft.error/1";
  readonly code: OperationErrorCode;
  readonly message: string;
  readonly errors: ValidationIssue[];
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: OperationError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export function err<T = never>(code: OperationErrorCode, message: string, extra: { errors?: ValidationIssue[]; retryable?: boolean; details?: Record<string, unknown> } = {}): Result<T> {
  return { ok: false, error: { schemaVersion: "paneweft.error/1", code, message, errors: extra.errors ?? [], retryable: extra.retryable ?? false, ...(extra.details === undefined ? {} : { details: extra.details }) } };
}

/** STUB marker. A stub returns this so that tests fail on assertions rather than on thrown errors. */
export function notImplemented(what: string): OperationError {
  return {
    schemaVersion: "paneweft.error/1",
    code: "NOT_IMPLEMENTED",
    message: `${what} is not implemented (red phase stub)`,
    errors: [],
    retryable: false,
  };
}

export function notImplementedResult<T>(what: string): Result<T> {
  return { ok: false, error: notImplemented(what) };
}
