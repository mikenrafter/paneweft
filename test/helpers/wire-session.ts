// Helpers of the `wire` test slice (CLI, MCP, viewer HTTP): seeded sessions, fixture access, the CLI command
// table, and lazily-created shared resources. Real sessions are directories made with openSession +
// importBundle; the expected values never come from here (literals live in the tests).
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { assert } from "vitest";
import { openSession, type Session } from "../../src/core/session.ts";
import { allBundle, FIXTURES, loadFixture } from "./fixtures.ts";
import { must } from "./must.ts";

/** Path of a request/payload file under fixtures/wire (committed literal JSON). */
export function wirePath(name: string): string {
  return join(FIXTURES, "wire", name);
}
export function wireJson<T = Record<string, any>>(name: string): T {
  return loadFixture<T>(`wire/${name}`);
}
/** The exact bytes of a request file, as text. */
export function wireText(name: string): string {
  return readFileSync(wirePath(name), "utf8");
}

/** The 13 MCP tool names (design section 5 table), pinned literally. */
export const TOOL_NAMES_LITERAL = [
  "list_components", "describe_component", "validate", "register_view", "render", "open_entity", "navigate",
  "inspect_view", "search", "notebook_create", "notebook_get", "notebook_update", "example_record",
] as const;
export type ToolNameLiteral = (typeof TOOL_NAMES_LITERAL)[number];

/** CLI words per tool (red-contract section 9). register_view has no CLI command. */
export const CLI_WORDS: Record<Exclude<ToolNameLiteral, "register_view">, string[]> = {
  list_components: ["components"],
  describe_component: ["describe"],
  validate: ["validate"],
  render: ["render"],
  open_entity: ["open"],
  navigate: ["navigate"],
  inspect_view: ["inspect"],
  search: ["search"],
  notebook_create: ["notebook", "create"],
  notebook_get: ["notebook", "get"],
  notebook_update: ["notebook", "update"],
  example_record: ["example", "record"],
};

export interface SeedOptions {
  /** wire fixture names of extra single-envelope views stored with putView after the bundle. */
  extraViews?: string[];
  /** Register repository `r` at this root. */
  repositoryRoot?: string;
}

/** Creates the session in `dir`, imports the all-components bundle and the extra views. Fails the test by assertion. */
export async function seedSession(dir: string, options: SeedOptions = {}): Promise<Session> {
  const session = must(await openSession(dir), "openSession");
  must(await session.importBundle(allBundle()), "importBundle(all.bundle)");
  for (const name of options.extraViews ?? []) must(await session.putView(wireJson(name)), `putView(${name})`);
  if (options.repositoryRoot !== undefined) must(await session.registerRepository({ id: "r", root: options.repositoryRoot }), "registerRepository");
  return session;
}
/** seedSession, then close it so spawned processes own the directory. */
export async function seedClosed(dir: string, options: SeedOptions = {}): Promise<string> {
  const session = await seedSession(dir, options);
  await session.close();
  return dir;
}

/** A temp directory outside useTempDirs (for resources shared by several tests of a file); removed in afterAll. */
export function sharedTempDirs(): (name: string) => string {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return (name) => {
    const dir = mkdtempSync(join(tmpdir(), `paneweft-wire-${name}-`));
    created.push(dir);
    return dir;
  };
}

/** Computes a resource at first use and disposes it in afterAll. A failed factory fails every user by its own assertion. */
export function lazyShared<T>(factory: () => Promise<T>, dispose: (value: T) => Promise<void> | void = () => {}): () => Promise<T> {
  let pending: Promise<T> | null = null;
  afterAll(async () => {
    if (pending === null) return;
    const settled = await pending.then(
      (value) => ({ value }),
      () => null,
    );
    if (settled !== null) await dispose(settled.value);
  });
  return () => (pending ??= factory());
}

/** Parses a reply/error body or fails the test with the body in the message. */
export function parseBody(body: string, context = "body"): Record<string, any> {
  try {
    const value: unknown = JSON.parse(body);
    assert.isObject(value, `${context} must be a JSON object`);
    return value as Record<string, any>;
  } catch (error) {
    return assert.fail(`${context} is not a JSON object: ${String(error)}; body starts: ${JSON.stringify(body.slice(0, 200))}`);
  }
}

/** Code and pointer pairs of an error body's `errors`, in the order the body lists them. */
export function issuePairs(errorBody: Record<string, any>): Array<[string, string]> {
  const errors: Array<{ code: string; pointer: string }> = errorBody.errors ?? [];
  return errors.map((issue) => [issue.code, issue.pointer]);
}

/** Non-blank lines of a text reply: whether a blank line separates header and body is not part of the contract. */
export function replyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** A tiny sandbox runner for example tests (fixtures/wire/runners/wire-runner.mjs): writes its own registry. */
export function runnerRegistryFor(options: { workspace: string; runnerId?: string; timeoutMs?: number }): string {
  return JSON.stringify({
    runners: [
      {
        id: options.runnerId ?? "wire-runner",
        executable: process.execPath,
        argv: [wirePath("runners/wire-runner.mjs"), options.workspace],
        workspaceRoot: options.workspace,
        parameterSchema: { type: "object", additionalProperties: false, properties: {} },
        timeoutMs: options.timeoutMs ?? 20000,
        outputBundlePath: "out.json",
      },
    ],
  });
}
