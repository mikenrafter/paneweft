// why: S3, matching literal hash tables did not detect a clean revision containing different bytes.
// CLAIM(demo-source-pins): each source and freshness pin hashes the bytes returned by git show at its recorded revision.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { residualBundle, storyBundle, vigilBundle } from "./helpers/demo-fixtures.ts";
import { REPO_ROOT } from "./helpers/fixtures.ts";
import { sha256Hex } from "./helpers/hash.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const temporary = useTempDirs();
const repositories = new Map<string, string>();
const prefixes: Record<string, string> = { vigil: "scout-modules/vigil/", "residual-web": "", paneweft: "" };
const views = [vigilBundle(), residualBundle(), storyBundle()].flatMap((bundle) => bundle.views);

beforeAll(() => {
  for (const id of Object.keys(prefixes)) {
    const directory = temporary(`git-${id}`);
    execFileSync("git", ["init", "--bare", "--quiet", directory]);
    execFileSync("git", ["-C", directory, "index-pack", "--stdin"], { input: readFileSync(join(REPO_ROOT, "fixtures/demos/git", `${id}.pack`)) });
    repositories.set(id, directory);
  }
});

describe("[S3] demo source pins match recorded Git bytes", () => {
  // One test keeps the shared repositories alive until useTempDirs' afterEach cleanup.
  // why: every source and every freshness file is checked against Git objects, including cross-repository story sources.
  it("[demo-source-pins] all nine views agree with git show <revision>:<path>", () => {
    expect(views).toHaveLength(9);
    for (const view of views) {
      for (const repository of view.freshness.repositories) {
        expect(repository.dirty, `${view.id}/${repository.id}`).toBe(false);
        for (const [path, recorded] of Object.entries(repository.files)) {
          const bytes = execFileSync("git", ["-C", repositories.get(repository.id)!, "show", `${repository.gitRev}:${prefixes[repository.id]}${path}`]);
          expect(recorded, `${view.id}/${repository.id}@${repository.gitRev}:${path}`).toBe(sha256Hex(bytes));
        }
      }
      for (const source of view.sources) {
        const repository = view.freshness.repositories.find((entry: { id: string }) => entry.id === source.repository)!;
        expect(repository, `${view.id}/${source.id} has a recorded revision`).toBeDefined();
        expect(source.sha256, `${view.id}/${source.id}`).toBe(repository.files[source.path]);
      }
    }
    const design = storyBundle().views[0];
    const registration = design.freshness.repositories.find((entry: { id: string }) => entry.id === "paneweft")!;
    expect(design.sources.find((source: { id: string }) => source.id === "sd")!.method).toContain(registration.gitRev);
  });
});
