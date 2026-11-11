// why: dogfooding note #4. `validate` returned `valid: bundle` for a bundle that `render` then refused with eight IDENTITY_CONFLICT issues against the
//   session, because `validate` ran the document checks only and never looked at what the session already holds (registered definitions, entities, stored
//   views). A validator that says yes where the very next call says no is worse than none. With a session, `validate` now makes the same decision
//   `render` would (the same checks, nothing stored); without one it still validates the document alone and its reply says so.
// CLAIM(validate-render-parity): for any input, `validate` with a session fails exactly where `render` does, with the same error, and `render` after a
//   successful `validate` is not refused for identity or snapshot reasons [this file].
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callOperation, failure, useOps } from "../../test/helpers/ops-env.ts";
import { allBundle, clone } from "../../test/helpers/fixtures.ts";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { parseBody } from "../../test/helpers/wire-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { writeFileSync } from "node:fs";

const open = useOps();
const tmp = useTempDirs();

/** Bundle B: nothing but one definition, so only the definition's identity is in question. */
const definitionOnly = (change: Record<string, unknown>) => {
  const base = clone(allBundle());
  const definition = { ...clone(base.definitions.find((d: { id: string }) => d.id === "def-modules")), ...change };
  return { schemaVersion: "paneweft.bundle/1", entities: [], definitions: [definition], views: [] };
};
const CASES: Array<[name: string, build: () => unknown, expected: "ok" | { code: string; issue?: string }]> = [
  ["the same bundle again (idempotent)", () => allBundle(), "ok"],
  ["a registered definition redefined with another component", () => definitionOnly({ component: "tree" }), { code: "VALIDATION_FAILED", issue: "IDENTITY_CONFLICT" }],
  ["a registered definition redefined with another entity kind", () => definitionOnly({ entityKind: "code/other" }), { code: "VALIDATION_FAILED", issue: "IDENTITY_CONFLICT" }],
  ["a registered definition with the same identity but another title", () => definitionOnly({ title: "Another title" }), { code: "SNAPSHOT_CONFLICT" }],
  ["a stored view resubmitted with other content", () => {
    const bundle = clone(allBundle());
    bundle.views[0].title = "A different title";
    return { ...bundle, entities: [], definitions: [] };
  }, { code: "SNAPSHOT_CONFLICT" }],
];

describe("[#4] validate with a session decides what render decides", () => {
  // why: the finding itself, case by case. For each input: validate (session) and render (a second, identical session) give the same verdict, and the same
  //   error when it is a refusal. Two sessions, because a successful render stores; a refusal stores nothing, so the order does not matter for them.
  it.each(CASES)("[#4] %s", async (_name, build, expected) => {
    const checking = await open(allBundle());
    const rendering = await open(allBundle());
    const validated = await checking.call("validate", { input: build(), format: "json" });
    const rendered = await rendering.call("render", { input: build(), format: "json" });
    expect(validated.ok, `validate ${validated.body.slice(0, 300)}`).toBe(rendered.ok);
    if (expected === "ok") {
      expect(validated.ok).toBe(true);
      return;
    }
    const error = failure(validated);
    expect(error).toEqual(failure(rendered));
    expect(error.code).toBe(expected.code);
    if (expected.issue !== undefined) expect(error.errors.map((issue) => issue.code)).toContain(expected.issue);
  });

  // why: validate must not store anything, whatever it answers: the session after a successful validate is the session before it.
  it("[#4] a successful validate stores nothing", async () => {
    const env = await open();
    const outcome = await env.call("validate", { input: allBundle(), format: "json" });
    expect(outcome.ok).toBe(true);
    expect(await env.session.listViews()).toEqual([]);
    expect((await env.session.listDefinitions()).definitions).toEqual([]);
  });

  // why: a lone envelope whose entity nobody registered is refused by render (DANGLING_REFERENCE) and, with a session, by validate; the same envelope
  //   inside the bundle that registers the entity is fine.
  it("[#4] a single envelope whose entity is not registered fails validate the way it fails render", async () => {
    const env = await open();
    const view = clone(allBundle().views[0]);
    const validated = await env.call("validate", { input: view, format: "json" });
    const rendered = await env.call("render", { input: view, format: "json" });
    expect(validated.ok).toBe(false);
    expect(failure(validated)).toEqual(failure(rendered));
  });
});

describe("[#4] the reply says what was checked", () => {
  // why: a validation that passed without a session says nothing about identity, and must not read like one that did.
  it("[#4] with a session: JSON identity is `session`; text says it checked against the session", async () => {
    const env = await open(allBundle());
    expect(JSON.parse((await env.call("validate", { input: allBundle(), format: "json" })).body).identity).toBe("session");
    const text = await env.call("validate", { input: allBundle() });
    expect(text.body).toMatch(/^valid: bundle\nidentity: session /);
  });
  it("[#4] without a session: identity is `none` and the text says identities were not compared and how to compare", async () => {
    const outcome = await callOperation(null, "validate", { input: allBundle(), format: "json" });
    expect(JSON.parse(outcome.body).identity).toBe("none");
    const text = await callOperation(null, "validate", { input: allBundle() });
    expect(text.body).toMatch(/^valid: bundle\nidentity: none \(.*--session/);
  });
});

describe("[#4] the CLI validate uses the session it is given", () => {
  const conflicting = () => {
    const file = join(tmp("validate-input"), "conflict.json");
    writeFileSync(file, JSON.stringify(definitionOnly({ component: "tree" })));
    return file;
  };
  // why: the CLI never opened a session for `validate`, so the session-aware check was unreachable from the command line, where the finding was made.
  it("[#4] --session DIR: the conflicting bundle is refused with IDENTITY_CONFLICT; without --session it is valid and says identity none", async () => {
    const env = await open(allBundle());
    const file = conflicting();
    const withSession = await runCliInProcess(["--session", env.dir, "validate", "--file", file]);
    expect(withSession.exitCode, withSession.stdout).toBe(1);
    expect(JSON.stringify(parseBody(withSession.stdout).errors)).toContain("IDENTITY_CONFLICT");
    const without = await runCliInProcess(["validate", "--file", file]);
    expect(without.exitCode).toBe(0);
    expect(without.stdout).toContain("identity: none");
  });
  // why: validating must not create a session directory that did not exist; with none, the validation is document-only and says so.
  it("[#4] a --session directory that does not exist is not created; the validation is labelled identity none", async () => {
    const dir = join(tmp("absent"), "no-such-session");
    const run = await runCliInProcess(["--session", dir, "validate", "--file", conflicting()]);
    expect(run.exitCode, run.stdout).toBe(0);
    expect(run.stdout).toContain("identity: none");
    expect(existsSync(dir)).toBe(false);
  });
});
