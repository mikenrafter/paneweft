// Local viewer server. docs/red-contract.md "Viewer HTTP" is normative.
// CLAIM(loopback-only): binds 127.0.0.1 (or ::1) only; a non-loopback host is refused before any socket exists [design section 5; server.test.ts, MC15].
// CLAIM(session-credential): every /api route needs `Authorization: Bearer <token>`; writes also need
//   a same-origin (or absent) Origin header [design section 5; server.test.ts, MC15].
// CLAIM(host-bound): every route, pages included, answers only its own `Host`, which defeats DNS rebinding [server.test.ts, MC15].
// CLAIM(no-cors): no response carries an Access-Control-* header, so a foreign page cannot read any answer [server.test.ts, MC15].
// CLAIM(contained-assets): static files come from the assets directory only; traversal, encoded dots and symlink escape are refused [server.test.ts, MC15].
// CLAIM(registered-only): the API serves what the session manifest registered and nothing else; no route executes anything [server.test.ts, MC15, MC20].
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type OperationError, type OperationErrorCode, type Result } from "../core/errors.ts";
import { confinedReadsSupported, readConfinedFile } from "../core/confined-read.ts";
import type { Session } from "../core/session.ts";
import type { EntityRef } from "../core/wire.ts";
import { createSessionSource } from "./session-source.ts";

export interface ViewerServerOptions {
  session: Session;
  /** Default 127.0.0.1. Anything non-loopback returns NON_LOOPBACK_HOST. */
  host?: string;
  /** Default 0 (ephemeral). */
  port?: number;
  /** Directory of bundled assets; default dist/viewer. */
  assetsDirectory?: string;
  /** v1: the session directory, where renderers.trust.json lives (docs/v1-red-contract.md section 12). RED: not used yet. */
  sessionDirectory?: string;
  /** v1: clock for capability-token expiry (milliseconds since the epoch); default Date.now. RED: not used yet. */
  clock?: () => number;
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

const DEFAULT_ASSETS = fileURLToPath(new URL("../../dist/viewer", import.meta.url));
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".map": "application/json; charset=utf-8",
  ".png": "image/png", ".txt": "text/plain; charset=utf-8",
};
const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const STATUS_OF: Partial<Record<OperationErrorCode, number>> = {
  NOT_FOUND: 404, UNRESOLVED_TARGET: 404, UNAUTHORIZED: 401, FORBIDDEN_ORIGIN: 403, CONFLICT: 409, SNAPSHOT_CONFLICT: 409,
  VALIDATION_FAILED: 422, INVALID_ARGUMENT: 400, CURSOR_INVALID: 400, INVALID_PATH: 400, PATH_OUTSIDE_ROOT: 403, UNSUPPORTED_PLATFORM: 501,
};

interface Reply { status: number; type: string; body: string | Buffer; extra?: Record<string, string> }
const jsonReply = (status: number, value: unknown): Reply => ({ status, type: "application/json; charset=utf-8", body: JSON.stringify(value) });
const errorReply = (error: OperationError, status: number = STATUS_OF[error.code] ?? 500): Reply => jsonReply(status, error);
const fail = (code: OperationErrorCode, message: string, status?: number, details?: Record<string, unknown>): Reply => {
  const failed = err(code, message, { retryable: code === "CONFLICT", ...(details === undefined ? {} : { details }) });
  return errorReply((failed as { error: OperationError }).error, status);
};
const fromResult = <T>(result: Result<T>, success: (value: T) => unknown): Reply => (result.ok ? jsonReply(200, success(result.value)) : errorReply(result.error));

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > MAX_BODY_BYTES) return { ok: false };
    parts.push(part);
  }
  return { ok: true, text: Buffer.concat(parts).toString("utf8") };
}

/**
 * Where confined reads are unsupported (not Linux, review round 2 S1) the viewer cannot vouch for a path at request time, so it serves
 * only its fixed bundle: the regular files that are direct children of the assets directory at start-up (symlinks and subdirectories
 * excluded, opened with O_NOFOLLOW), held in memory. The assets directory is the product's own build output, trusted at start-up.
 */
async function loadBundle(root: string): Promise<Map<string, Buffer>> {
  const bundle = new Map<string, Buffer>();
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const handle = await open(join(root, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (handle === null) continue;
    try {
      if ((await handle.stat()).isFile()) bundle.set(entry.name, await handle.readFile());
    } catch { /* unreadable: not part of the bundle */ } finally {
      await handle.close().catch(() => {});
    }
  }
  return bundle;
}

/** A static file strictly inside `root`, read from a verified handle (CLAIM(confined-read)), or from the fixed `bundle` where that is unsupported. The path is decoded once; anything that is not a plain relative file name is refused. */
async function readAsset(root: string, encoded: string, bundle: Map<string, Buffer> | null): Promise<{ file: string; bytes: Buffer } | { status: 400 | 404 }> {
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { return { status: 400 }; }
  if (decoded.includes("\0")) return { status: 400 };
  if (decoded.includes("\\")) return { status: 404 };
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return { status: 404 };
  if (bundle !== null) {
    const name = segments.length === 1 ? (segments[0] as string) : null;
    const bytes = name === null ? undefined : bundle.get(name);
    return name !== null && bytes !== undefined ? { file: name, bytes } : { status: 404 };
  }
  const read = await readConfinedFile(root, segments.join("/"));
  return read.ok ? { file: read.realPath, bytes: read.bytes } : { status: 404 };
}

function excerptLines(text: string, first: number): Array<{ n: number; text: string }> {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line, index) => ({ n: first + index, text: line }));
}

const isLoopback = (host: string): boolean => host === "127.0.0.1" || host === "::1";

export async function startViewer(options: ViewerServerOptions): Promise<Result<ViewerServer>> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) return err("NON_LOOPBACK_HOST", `the viewer binds only 127.0.0.1 or ::1, not "${host}"`);
  const { session } = options;
  const assets = options.assetsDirectory ?? DEFAULT_ASSETS;
  const bundle = confinedReadsSupported() ? null : await loadBundle(assets);
  const token = randomBytes(32).toString("hex");
  const source = createSessionSource(session);
  let origin = "";
  let hostHeader = "";

  const entityRefOf = (query: URLSearchParams): { entity: EntityRef; snapshotId: string } | null => {
    const [snapshotId, repository, id, kind] = ["snapshot", "repository", "id", "kind"].map((name) => query.get(name));
    return snapshotId && repository && id && kind ? { entity: { repository, id, kind }, snapshotId } : null;
  };

  async function readRoute(path: string, query: URLSearchParams): Promise<Reply> {
    switch (path) {
      case "/api/index": {
        const read = await session.snapshot(); // one manifest read; no stored object is opened (T5)
        const views = (await read.listViewIndex()).map((view) => ({ viewId: view.viewId, snapshotId: view.snapshotId, component: view.component, title: view.title, viewDefinitionId: view.viewDefinitionId, entity: view.entity }));
        return jsonReply(200, { entities: await read.listEntities(), views });
      }
      case "/api/registry":
        return jsonReply(200, await session.listDefinitions());
      case "/api/entity": {
        const target = entityRefOf(query);
        if (target === null) return fail("INVALID_ARGUMENT", "entity needs snapshot, repository, id and kind");
        const entity = await source.getEntity(target.entity, target.snapshotId);
        if (!entity.ok) return errorReply(entity.error);
        const views = await source.applicableViews(target.entity, target.snapshotId, query.get("preferred") ?? undefined);
        return fromResult(views, (ranked) => ({ entity: entity.value, views: ranked }));
      }
      case "/api/view": {
        const [viewId, snapshotId] = [query.get("viewId"), query.get("snapshotId")];
        if (!viewId || !snapshotId) return fail("INVALID_ARGUMENT", "view needs viewId and snapshotId");
        return fromResult(await source.getView({ viewId, snapshotId }), (model) => model);
      }
      case "/api/source": {
        const [viewId, snapshotId, itemId] = [query.get("viewId"), query.get("snapshotId"), query.get("itemId")];
        if (!viewId || !snapshotId || !itemId) return fail("INVALID_ARGUMENT", "source needs viewId, snapshotId and itemId (ids, never paths)");
        const opened = await source.openItemSource({ viewId, snapshotId }, itemId);
        if (!opened.ok) return errorReply(opened.error);
        const opening = opened.value;
        if (opening.status === "unresolved") return fail("UNRESOLVED_TARGET", opening.message);
        // numberedLines are the whole stored excerpt, numbered by file line; `highlight` says which of them the item covers.
        const holder = opening.stored.viewId === null ? null : await session.getView({ viewId: opening.stored.viewId, snapshotId: opening.stored.snapshotId });
        const excerpt = holder !== null && holder.ok && holder.value.envelope.component === "source"
          ? (holder.value.envelope.data as { excerpt: { text: string; anchor: { lines: [number, number] } } }).excerpt : null;
        const numberedLines = excerpt === null ? opening.stored.lines : excerptLines(excerpt.text, excerpt.anchor.lines[0]);
        return jsonReply(200, {
          currency: opening.currency.state === "fresh" ? "current" : opening.currency.state,
          numberedLines,
          highlight: opening.highlight,
          revision: opening.revision,
          repository: opening.repository,
          path: opening.path,
          origin: opening.origin,
          viewId: opening.stored.viewId,
          snapshotId: opening.stored.snapshotId,
          recordedSha256: opening.currency.recordedSha256,
          currentSha256: opening.currency.currentSha256,
        });
      }
      case "/api/search": {
        const text = query.get("q");
        if (text === null) return fail("INVALID_ARGUMENT", "search needs q");
        const scope = entityRefOf(query);
        return fromResult(await source.search(text, scope ?? undefined), (hits) => ({ hits }));
      }
      default:
        return fail("NOT_FOUND", `no route ${path}`);
    }
  }

  async function writeRoute(request: IncomingMessage, pageId: string): Promise<Reply> {
    const received = request.headers.origin;
    if (received !== undefined && received !== origin) return fail("FORBIDDEN_ORIGIN", "writes must come from the viewer's own origin", 403);
    const body = await readBody(request);
    if (!body.ok) return fail("INVALID_ARGUMENT", "request body too large", 413);
    let parsed: unknown;
    try { parsed = JSON.parse(body.text); } catch { return fail("INVALID_ARGUMENT", "the request body is not JSON", 400); }
    const write = parsed as { snapshotId?: unknown; expectedRevision?: unknown; blocks?: unknown } | null;
    if (write === null || typeof write !== "object" || !Number.isInteger(write.expectedRevision) || (write.expectedRevision as number) < 1 || !Array.isArray(write.blocks)
      || (write.snapshotId !== undefined && (typeof write.snapshotId !== "string" || write.snapshotId === ""))) {
      return fail("INVALID_ARGUMENT", "the body must be {snapshotId?: string, expectedRevision: integer >= 1, blocks: array}", 400);
    }
    const updated = await source.updateNotebook(pageId, write.expectedRevision as number, write.blocks, write.snapshotId as string | undefined);
    return fromResult(updated, (page) => page);
  }

  async function route(request: IncomingMessage): Promise<Reply> {
    if (request.headers.host !== hostHeader) return fail("FORBIDDEN_ORIGIN", "this viewer answers only its own host", 403);
    const target = request.url ?? "/";
    const cut = target.indexOf("?");
    const rawPath = cut < 0 ? target : target.slice(0, cut);
    const query = new URLSearchParams(cut < 0 ? "" : target.slice(cut + 1));
    const method = request.method ?? "GET";

    if (rawPath === "/api" || rawPath.startsWith("/api/")) {
      const authorization = request.headers.authorization ?? "";
      const presented = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
      if (presented === "" || !constantTimeEqual(presented, token)) return fail("UNAUTHORIZED", "missing or wrong session token", 401);
      const notebook = /^\/api\/notebooks\/([^/]+)\/revisions$/.exec(rawPath);
      if (notebook !== null && method === "POST") {
        let pageId: string;
        try { pageId = decodeURIComponent(notebook[1] as string); } catch { return fail("INVALID_ARGUMENT", "bad page id", 400); }
        return writeRoute(request, pageId);
      }
      if (method !== "GET") return fail("NOT_FOUND", `no route ${method} ${rawPath}`);
      return readRoute(rawPath, query);
    }

    if (method !== "GET" && method !== "HEAD") return fail("NOT_FOUND", `no route ${method} ${rawPath}`);
    const asset = rawPath === "/" ? "index.html" : rawPath.startsWith("/assets/") ? rawPath.slice("/assets/".length) : null;
    if (asset === null) return fail("NOT_FOUND", `no route ${rawPath}`);
    const found = await readAsset(assets, asset, bundle);
    if (!("file" in found)) return fail(found.status === 400 ? "INVALID_ARGUMENT" : "NOT_FOUND", `no asset ${rawPath}`, found.status);
    return { status: 200, type: CONTENT_TYPES[extname(found.file)] ?? "application/octet-stream", body: found.bytes, extra: PAGE_HEADERS };
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    route(request).catch((error: unknown) => fail("INTERNAL", `the viewer failed: ${String(error)}`, 500)).then((reply) => {
      response.writeHead(reply.status, { "Content-Type": reply.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(reply.extra ?? {}) });
      response.end(request.method === "HEAD" ? undefined : reply.body);
    }, () => response.destroy());
  });

  const listening = await new Promise<Result<void>>((resolve) => {
    server.once("error", (error: Error) => resolve(err("STORAGE_FAILED", `the viewer could not listen on ${host}: ${error.message}`)));
    server.listen(options.port ?? 0, host, () => resolve(ok(undefined)));
  });
  if (!listening.ok) return listening;
  const port = (server.address() as AddressInfo).port;
  hostHeader = host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
  origin = `http://${hostHeader}`;

  // CLAIM(atomic-server-json): the credential goes into a fresh 0600 file (O_EXCL: never a planted link) next to server.json and is renamed over it, so
  //   whatever was at server.json (a symlink, a hard link, a wider-mode file) is replaced, never written through, and a reader sees the old file or the new one whole.
  const serverFile = join(session.dir, "server.json");
  const temporaryFile = `${serverFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(temporaryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ origin, token, pid: process.pid })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryFile, serverFile);
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => {});
    server.close();
    return err("STORAGE_FAILED", `server.json could not be written: ${String(error)}`);
  }

  let closing: Promise<void> | null = null;
  return ok({
    host, port, origin, token,
    urlFor: (key) => `${origin}/#token=${token}${key === undefined ? "" : `&view=${encodeURIComponent(key.viewId)}&snapshot=${encodeURIComponent(key.snapshotId)}`}`,
    close: () => (closing ??= (async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      try {
        const current = JSON.parse(await readFile(serverFile, "utf8")) as { token?: string };
        if (current.token === token) await rm(serverFile, { force: true });
      } catch { /* already gone */ }
    })()),
  });
}
