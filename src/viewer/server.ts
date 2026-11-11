// Local viewer server. docs/red-contract.md "Viewer HTTP" is normative.
// CLAIM(loopback-only): binds 127.0.0.1 (or ::1) only; a non-loopback host is refused [design section 5; server.test.ts, MC15].
// CLAIM(session-credential): every /api route needs `Authorization: Bearer <token>`; writes also need
//   a same-origin (or absent) Origin header [design section 5; server.test.ts, MC15].
import type { Session } from "../core/session.ts";
import { notImplementedResult, type Result } from "../core/errors.ts";

export interface ViewerServerOptions {
  session: Session;
  /** Default 127.0.0.1. Anything non-loopback returns NON_LOOPBACK_HOST. */
  host?: string;
  /** Default 0 (ephemeral). */
  port?: number;
  /** Directory of bundled assets; default dist/viewer. */
  assetsDirectory?: string;
}
export interface ViewerServer {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  /** Session credential: at least 128 bits of entropy, unique per server instance. */
  readonly token: string;
  /** `${origin}/#token=${token}` plus `&view=<viewId>&snapshot=<snapshotId>` when given. */
  urlFor(key?: { viewId: string; snapshotId: string }): string;
  close(): Promise<void>;
}

/** STUB. */
export async function startViewer(_options: ViewerServerOptions): Promise<Result<ViewerServer>> {
  return notImplementedResult("startViewer");
}
