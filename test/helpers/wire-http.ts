// HTTP helpers of the `wire` slice.
// Why not test/helpers/http.ts alone: its `new URL(...)` normalises `..` and `%2e%2e` segments away before
// the request leaves the test, which would turn every traversal attempt into a harmless request for
// `/package.json`. rawRequest sends the request target byte for byte.
import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, assert } from "vitest";
import { createSchemaRegistry } from "../../src/schemas/index.ts";
import { startViewer, type ViewerServer, type ViewerServerOptions } from "../../src/viewer/server.ts";
import { openSession, type Session } from "../../src/core/session.ts";
import { REPO_ROOT } from "./fixtures.ts";
import { must } from "./must.ts";
import { useTempDirs } from "./tmp.ts";
import { seedSession, type SeedOptions } from "./wire-session.ts";

export const DIST_VIEWER = join(REPO_ROOT, "dist", "viewer");

export interface RawReply { status: number; headers: IncomingHttpHeaders; text: string; error?: string }

/** Sends `target` exactly as given (no URL normalisation). Connection failures become status 0. */
export function rawRequest(server: { host: string; port: number }, target: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawReply> {
  return new Promise((resolve) => {
    const req = request({ host: server.host, port: server.port, path: target, method: options.method ?? "GET", headers: options.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (part: Buffer) => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, headers: {}, text: "", error: String(error) }));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

export function jsonOf(reply: RawReply, context = "reply"): any {
  try {
    return JSON.parse(reply.text);
  } catch (error) {
    return assert.fail(`${context} (status ${reply.status}) is not JSON: ${String(error)}; body starts ${JSON.stringify(reply.text.slice(0, 200))}`);
  }
}

/** Asserts a reply is a paneweft.error/1 body (validated with raw Ajv against the canonical error schema) and returns it. */
export function expectErrorBody(reply: RawReply, expectedStatus: number | number[], expectedCode: string): Record<string, any> {
  const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assert.include(allowed, reply.status, `status; body ${reply.text.slice(0, 200)}`);
  const body = jsonOf(reply);
  const validate = createSchemaRegistry().getSchema("urn:paneweft:schema:error:1");
  assert.isOk(validate, "the error schema must be registered");
  assert.isTrue(validate!(body), `body must satisfy error.schema.json: ${JSON.stringify(validate!.errors)}; body ${reply.text.slice(0, 200)}`);
  assert.equal(body.code, expectedCode);
  assert.match(String(reply.headers["content-type"] ?? ""), /^application\/json/i, "error bodies are JSON");
  return body;
}

/** TCP connect attempt: resolves with the error code on failure, "connected" with the remote address on success. */
export function tcpProbe(host: string, port: number): Promise<{ result: "connected"; remoteAddress: string | undefined } | { result: "failed"; code: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ result: "failed", code: "TIMEOUT" });
    }, 3000);
    socket.on("connect", () => {
      clearTimeout(timer);
      const remoteAddress = socket.remoteAddress;
      socket.destroy();
      resolve({ result: "connected", remoteAddress });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ result: "failed", code: error.code ?? String(error) });
    });
  });
}

/** Every file under `directory` as relative path -> "sha256:mtimeMs" (the probe for "no rebuild"). */
export function treeFingerprint(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) visit(full);
      else result[relative(directory, full)] = `${createHash("sha256").update(readFileSync(full)).digest("hex")}:${info.mtimeMs}`;
    }
  };
  if (existsSync(directory)) visit(directory);
  return result;
}

export interface RunningViewer { dir: string; session: Session; server: ViewerServer }

/** Starts viewers over real session directories and closes everything after each test. */
export function useViewers() {
  const makeTemp = useTempDirs();
  const servers: ViewerServer[] = [];
  const sessions: Session[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close().catch(() => {});
    for (const session of sessions.splice(0)) await session.close().catch(() => {});
  });
  return {
    makeTemp,
    /** A seeded session plus a running viewer; fails the test by assertion when either cannot be created. */
    async start(seed: SeedOptions = {}, options: Partial<ViewerServerOptions> = {}, dir: string = makeTemp("viewer")): Promise<RunningViewer> {
      const session = await seedSession(dir, seed);
      sessions.push(session);
      const server = must(await startViewer({ session, assetsDirectory: DIST_VIEWER, ...options }), "startViewer");
      servers.push(server);
      return { dir, session, server };
    },
    /** A seeded session without a viewer, for tests that call startViewer themselves. */
    async session(seed: SeedOptions = {}, dir: string = makeTemp("viewer")): Promise<{ dir: string; session: Session }> {
      const session = await seedSession(dir, seed);
      sessions.push(session);
      return { dir, session };
    },
    /** An empty session (no bundle) for restart tests that import by themselves. */
    async emptySession(dir: string): Promise<Session> {
      const session = must(await openSession(dir), "openSession");
      sessions.push(session);
      return session;
    },
    track(server: ViewerServer): ViewerServer {
      servers.push(server);
      return server;
    },
  };
}

