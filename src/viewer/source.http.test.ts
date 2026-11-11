// why: N5 (final spec review). The browser asks the server for an entity by its FULL identity (repository, kind, id) and snapshot. The
//   fixture server knows two entities that share id `mcp` and kind `code/module` in repositories `r` and `other`; an adapter that
//   drops the repository (or sends the wrong one) cannot get the right answer from it, and the answer is told apart by its label.
//   Runs the real createHttpSource over a real socket against the fixture server; nothing about the adapter is mocked.
// proves: CLAIM(N5-entity-identity) CLAIM(MC8)
import { afterEach, describe, expect, it } from "vitest";
import { createHttpSource } from "./source.ts";
import { API_TOKEN, startFixtureServer, type FixtureServer } from "../../test/helpers/http-fixture-server.ts";
import { must, mustFail } from "../../test/helpers/must.ts";

const servers: FixtureServer[] = [];
afterEach(async () => void (await Promise.all(servers.splice(0).map((server) => server.close()))));
async function sourceOverFixtures() {
  const server = await startFixtureServer();
  servers.push(server);
  return { server, source: createHttpSource(server.origin, API_TOKEN) };
}
const MINE = { repository: "r", id: "mcp", kind: "code/module" };
const DECOY = { repository: "other", id: "mcp", kind: "code/module" };

describe("[N5] the HTTP source addresses entities by repository, kind and id", () => {
  it("[N5] getEntity returns the entity of the asked repository: r -> 'mcp.rs', other -> the decoy; both requests name repository, kind, id and snapshot", async () => {
    const { server, source } = await sourceOverFixtures();
    expect(must(await source.getEntity(MINE, "snap-1")).label).toBe("mcp.rs");
    expect(must(await source.getEntity(DECOY, "snap-1")).label).toBe("mcp.rs (decoy in another repository)");
    const asked = server.requests.filter((request) => request.path === "/api/entity").map((request) => [request.query.get("snapshot"), request.query.get("repository"), request.query.get("kind"), request.query.get("id"), request.authorization]);
    expect(asked).toEqual([
      ["snap-1", "r", "code/module", "mcp", `Bearer ${API_TOKEN}`],
      ["snap-1", "other", "code/module", "mcp", `Bearer ${API_TOKEN}`],
    ]);
  });

  it("[N5] applicableViews takes the same identity: the decoy and the original are separate answers, an unknown repository is NOT_FOUND", async () => {
    const { source } = await sourceOverFixtures();
    const mine = must(await source.applicableViews(MINE, "snap-1"));
    expect(mine.selected).toEqual({ definitionId: "builtin:metadata" });
    must(await source.applicableViews(DECOY, "snap-1"));
    expect(mustFail(await source.applicableViews({ ...MINE, repository: "nowhere" }, "snap-1"), "unknown repository").code).toBe("NOT_FOUND");
  });

  it("[N5] getViewFor finds the instance of a definition through the index; the notebook model carries its revision (N1)", async () => {
    const { source } = await sourceOverFixtures();
    const watch = { repository: "r", id: "watch", kind: "vigil/watch" };
    const modules = must(await source.getViewFor(watch, "snap-1", "def-modules"));
    expect(modules.envelope.id).toBe("modules");
    expect(modules.notebookRevision).toBeUndefined();
    const notebook = must(await source.getView({ viewId: "cancellation-notebook", snapshotId: "snap-1" }));
    expect(notebook.notebookRevision).toBe(1);
  });
});
