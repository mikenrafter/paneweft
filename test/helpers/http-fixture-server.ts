// A plain node:http server that answers the viewer API from the committed success fixtures in fixtures/http (S7). It is NOT
// the viewer server: it holds no session and no logic beyond a route table, a bearer check and one stateful notebook, so the
// SHIPPED browser bundle can be exercised without the server implementation. Every request is recorded.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FIXTURES } from "./fixtures.ts";

export const API_TOKEN = "tok-s7-0123456789abcdef";
export interface RecordedRequest { method: string; path: string; query: URLSearchParams; authorization: string | null; origin: string | null; body: unknown }
export interface FixtureServer {
  origin: string;
  requests: RecordedRequest[];
  /** The notebook as the server currently stores it: revision and block ids in order. */
  notebook: { revision: number; blockIds: string[] };
  close(): Promise<void>;
}

const read = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, "http", name), "utf8"));
const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
const error = (status: number, code: string, message: string, details?: unknown) =>
  json(status, { schemaVersion: "paneweft.error/1", code, message, errors: [], retryable: code === "CONFLICT", ...(details === undefined ? {} : { details }) });

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const state = { notebookRevision: 1, view: read("view.cancellation-notebook.json") };
  // N5: entities are routed by their FULL identity (repository, kind, id) plus the snapshot. `mcp` exists twice with the same id
  // and kind in two repositories, so an adapter that drops (or mixes up) the repository gets the wrong entity or a 404.
  const entityFiles: Record<string, string> = {
    "r|vigil/watch|watch": "entity.watch.json",
    "r|notes/page|notes": "entity.notes.json",
    "r|code/module|mcp": "entity.mcp.json",
    "other|code/module|mcp": "entity.mcp.decoy.json",
  };
  const viewFiles: Record<string, string> = { modules: "view.modules.json", "delivery-path": "view.delivery-path.json" };

  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (part: Buffer) => chunks.push(part));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fixture.invalid");
      let body: unknown = null;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw !== "") { try { body = JSON.parse(raw); } catch { body = raw; } }
      const record: RecordedRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, authorization: req.headers.authorization ?? null, origin: req.headers.origin ?? null, body };
      requests.push(record);
      const reply = ((): { status: number; text: string } => {
        if (record.authorization !== `Bearer ${API_TOKEN}`) return error(401, "UNAUTHORIZED", "missing or wrong session token");
        if (record.method === "GET" && url.pathname === "/api/index") return json(200, read("index.json"));
        if (record.method === "GET" && url.pathname === "/api/registry") return json(200, read("registry.json"));
        if (record.method === "GET" && url.pathname === "/api/entity") {
          const identity = ["repository", "kind", "id"].map((name) => url.searchParams.get(name)).join("|");
          const file = entityFiles[identity];
          return file === undefined || url.searchParams.get("snapshot") !== "snap-1" ? error(404, "NOT_FOUND", `unknown entity ${identity}`) : json(200, read(file));
        }
        if (record.method === "GET" && url.pathname === "/api/view") {
          const id = url.searchParams.get("viewId") ?? "";
          if (url.searchParams.get("snapshotId") !== "snap-1") return error(404, "NOT_FOUND", "unknown snapshot");
          if (id === "cancellation-notebook") return json(200, state.view);
          const file = viewFiles[id];
          return file === undefined ? error(404, "NOT_FOUND", "unknown view") : json(200, read(file));
        }
        if (record.method === "POST" && url.pathname === "/api/notebooks/cancellation-notebook/revisions") {
          const request = body as { expectedRevision?: number; blocks?: Array<{ id: string }> } | null;
          if (request === null || typeof request !== "object") return error(400, "INVALID_ARGUMENT", "malformed body");
          if (request.expectedRevision !== state.notebookRevision) return error(409, "CONFLICT", "stale revision", { currentRevision: state.notebookRevision });
          // The server accepts exactly the write the fixture describes; any other body is a browser bug, reported as such.
          if (!isDeepStrictEqual(request, read("notebook.request.json"))) return error(400, "INVALID_ARGUMENT", "unexpected notebook body");
          state.notebookRevision = 2;
          state.view = read("view.cancellation-notebook.rev2.json");
          return json(200, read("notebook.rev2.json"));
        }
        return error(404, "NOT_FOUND", "unknown route");
      })();
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    get notebook() { return { revision: state.notebookRevision, blockIds: state.view.envelope.data.blocks.map((block: { id: string }) => block.id) }; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
