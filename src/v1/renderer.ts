// Repo-owned custom renderers: trust, delivery headers, capability tokens and the frame message contract (S4, N3; IV12, IV13).
import type { Result } from "../core/errors.ts";
import { notImplemented } from "./stub.ts";

/** The iframe sandbox attribute: scripts only. No allow-same-origin (opaque origin), forms, popups, downloads or top navigation. */
export const RENDERER_IFRAME_SANDBOX = "allow-scripts";
export const RENDERER_REFERRER_POLICY = "no-referrer";
/** The directive the PARENT page's CSP gains so it may frame the renderer routes. */
export const PARENT_FRAME_SRC = "frame-src 'self'";

/** Response headers of every /renderer/<digest>/<token>/<file> response. STUB: {}. */
export function rendererResponseHeaders(): Record<string, string> {
  return {};
}

/** The allowlisted files of a renderer directory; nothing else is served or hashed. */
export const RENDERER_FILES = ["renderer.json", "bundle.js", "style.css"] as const;

/** sha256 over the allowlisted files of `<root>/<dir>`, in a fixed order with their names. Never runs npm lifecycle scripts. STUB. */
export function digestRenderer(root: string, dir: string): Promise<Result<{ digest: string; files: string[] }>> {
  return Promise.resolve(notImplemented("digestRenderer"));
}

export interface TrustEntry {
  repo: string;
  id: string;
  digest: string;
}

/** The trust store lives in the session directory (renderers.trust.json), outside every submitted bundle; no MCP tool writes it. */
export interface TrustStore {
  trust(entry: TrustEntry): Promise<Result<void>>;
  isTrusted(entry: TrustEntry): Promise<boolean>;
  list(): Promise<TrustEntry[]>;
}

export function openTrustStore(sessionDir: string): TrustStore {
  return { trust: () => Promise.resolve(notImplemented("trust")), isTrusted: () => Promise.resolve(false), list: () => Promise.resolve([]) };
}

export interface CapabilityIssuer {
  /** A short-lived token scoped to ONE renderer digest and one frame. */
  mint(args: { digest: string; frameId: string }): { token: string; expiresAt: number };
  verify(token: string, digest: string): boolean;
}

export function createCapabilityIssuer(options: { now: () => number; ttlMs: number }): CapabilityIssuer {
  return { mint: () => ({ token: "", expiresAt: 0 }), verify: () => true };
}

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

/** The host's check of one renderer->host message (section 12). Pure. A rejection never throws and says why; ACCEPTING advances
 * `lastSeq`. STUB: accepts nothing. */
export function validateFrameMessage(
  state: FrameState,
  raw: unknown,
  channel: { windowMatches: boolean; handshakeDone: boolean },
): { accept: true; state: FrameState } | { accept: false; reason: FrameRejection; revokePort: boolean } {
  return { accept: false, reason: "NOT_IMPLEMENTED" as FrameRejection, revokePort: false };
}

/** Validates the data of a `custom` view: the renderer is trusted, the payload satisfies the locally registered schema (no network
 * loading; only bounded local $refs), a standard fallback is present and valid, every named object id is a string `oN`. STUB. */
export function validateCustomView(data: unknown, registry: { trustedDigests: string[]; schemas: Record<string, unknown> }): Result<true> {
  return notImplemented("validateCustomView");
}
