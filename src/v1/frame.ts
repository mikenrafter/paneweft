// The renderer frame message contract, host side (spec section 5; docs/v1-red-contract.md section 12). Pure and browser-safe: the viewer
// bundle imports this file, so it uses no Node module. renderer.ts re-exports it.

/** The iframe sandbox attribute: scripts only. No allow-same-origin (opaque origin), forms, popups, downloads or top navigation. */
export const RENDERER_IFRAME_SANDBOX = "allow-scripts";
export const RENDERER_REFERRER_POLICY = "no-referrer";
/** The directive the PARENT page's CSP gains so it may frame the renderer routes. */
export const PARENT_FRAME_SRC = "frame-src 'self'";

export interface FrameState {
  frameId: string;
  /** The per-frame random nonce delivered in the bootstrap message; the renderer's first (`ready`) message must echo it. */
  nonce: string;
  viewId: string;
  snapshotId: string;
  /** Object ids this view permits the renderer to name. */
  permittedObjects: string[];
  /** Highest sequence number accepted so far. */
  lastSeq: number;
  closed: boolean;
  requestsInWindow: number;
}

export type FrameRejection = "CLOSED" | "NO_HANDSHAKE" | "BAD_NONCE" | "WINDOW_MISMATCH" | "BAD_SHAPE" | "PROTOCOL_VERSION" | "WRONG_FRAME" | "WRONG_VIEW" | "WRONG_SNAPSHOT" | "SEQ_NOT_MONOTONIC" | "TOO_LARGE" | "UNKNOWN_TYPE" | "UNPERMITTED_OBJECT" | "RATE_LIMITED";

export const FRAME_MESSAGE_MAX_BYTES = 64 * 1024;
const RENDERER_TYPES = ["ready", "resize", "select_item", "open_object", "request_page", "render_error"] as const;
const REQUEST_LIMIT = 50;

/** The host's check of one renderer->host message (section 12). Pure. A rejection never throws and says why; ACCEPTING advances
 * `lastSeq`. Only an unexpected window or a closed frame revokes the port. */
export function validateFrameMessage(
  state: FrameState,
  raw: unknown,
  channel: { windowMatches: boolean; handshakeDone: boolean },
): { accept: true; state: FrameState } | { accept: false; reason: FrameRejection; revokePort: boolean } {
  const reject = (reason: FrameRejection, revokePort = false): { accept: false; reason: FrameRejection; revokePort: boolean } => ({ accept: false, reason, revokePort });
  if (state.closed) return reject("CLOSED", true);
  if (!channel.windowMatches) return reject("WINDOW_MISMATCH", true);
  const candidate = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!channel.handshakeDone && candidate?.type !== "ready") return reject("NO_HANDSHAKE");
  if (candidate === undefined) return reject("BAD_SHAPE");
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
  if (typeof candidate.protocol !== "number" || typeof candidate.type !== "string" || !text(candidate.frameId) || !text(candidate.viewId) || !text(candidate.snapshotId) || !text(candidate.requestId) || !Number.isInteger(candidate.seq) || (candidate.body !== undefined && (candidate.body === null || typeof candidate.body !== "object" || Array.isArray(candidate.body)))) return reject("BAD_SHAPE");
  if (candidate.protocol !== 1) return reject("PROTOCOL_VERSION");
  if (candidate.frameId !== state.frameId) return reject("WRONG_FRAME");
  if (candidate.viewId !== state.viewId) return reject("WRONG_VIEW");
  if (candidate.snapshotId !== state.snapshotId) return reject("WRONG_SNAPSHOT");
  const seq = candidate.seq as number;
  if (seq <= state.lastSeq) return reject("SEQ_NOT_MONOTONIC");
  if (!(RENDERER_TYPES as readonly string[]).includes(candidate.type)) return reject("UNKNOWN_TYPE");
  // postMessage clones what JSON cannot carry (cycles, BigInt), and a hostile toJSON can throw: a message that cannot be measured is malformed
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(candidate)).length;
  } catch {
    return reject("BAD_SHAPE");
  }
  if (size > FRAME_MESSAGE_MAX_BYTES) return reject("TOO_LARGE");
  const body = (candidate.body ?? {}) as Record<string, unknown>;
  if (candidate.type === "ready" && body.nonce !== state.nonce) return reject("BAD_NONCE");
  if ((candidate.type === "open_object" || candidate.type === "select_item") && (typeof body.object !== "string" || !state.permittedObjects.includes(body.object))) return reject("UNPERMITTED_OBJECT");
  if (state.requestsInWindow >= REQUEST_LIMIT) return reject("RATE_LIMITED");
  return { accept: true, state: { ...state, lastSeq: seq } };
}

