// WHY CLAIM(S39): collectionBytes bounds ONE capture document (docs/v1-red-contract.md sections 2 and 5), not the whole staging directory.
// The directory has its own ceiling, so many valid captures never starve the native report (reporter.json, typecheck.json) or the invocations.
import { open, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { readStaging } from "./staging.ts";

const tmp = useTempDirs();
afterEach(() => vi.restoreAllMocks());

const LIMIT = 10_000;
/** A JSON document of exactly `size` bytes (trailing whitespace is valid JSON). */
const sized = (size: number, body: object = { ok: true }): string => { const text = JSON.stringify(body); return text + " ".repeat(Math.max(0, size - text.length)); };
async function stage(parts: { captures?: number[]; captureSize?: number; invocations?: number; reporter?: object; typecheck?: object }): Promise<string> {
  const dir = tmp("staging");
  for (const sub of ["captures", "invocations", "catalogue"]) await mkdir(join(dir, sub), { recursive: true });
  for (const [index, size] of (parts.captures ?? []).entries()) await writeFile(join(dir, "captures", `inv-${index + 1}.json`), sized(size, { captureId: `inv-${index + 1}` }));
  for (let index = 1; index <= (parts.invocations ?? 0); index += 1) {
    await writeFile(join(dir, "invocations", `inv-${index}.started.json`), sized(1000, { id: `inv-${index}`, startedAt: "t" }));
    await writeFile(join(dir, "invocations", `inv-${index}.json`), sized(1000, { id: `inv-${index}`, startedAt: "t" }));
  }
  if (parts.reporter !== undefined) await writeFile(join(dir, "reporter.json"), JSON.stringify(parts.reporter));
  if (parts.typecheck !== undefined) await writeFile(join(dir, "typecheck.json"), JSON.stringify(parts.typecheck));
  return dir;
}

// Rejects: one budget of collectionBytes spent across all captures (the third 4000-byte capture of a 10000 limit was refused).
it("[S39] reads every capture that is under collectionBytes, however many bytes they add up to", async () => {
  const dir = await stage({ captures: [4000, 4000, 4000, 4000, 4000] });
  const staging = await readStaging(dir, LIMIT);
  expect([...staging.captures.values()].map((c) => [c.bytes, c.document !== undefined])).toEqual(Array.from({ length: 5 }, () => [4000, true]));
});

// Rejects: the native report read after the captures from the same budget (reporter.json and typecheck.json came back undefined).
it("[S39] keeps reporter.json and typecheck.json after many captures that together exceed collectionBytes", async () => {
  const dir = await stage({ captures: Array.from({ length: 20 }, () => 9000), reporter: { schemaVersion: "paneweft.vitest-report/1", tests: [] }, typecheck: { exitCode: 2, output: "error TS1" } });
  const staging = await readStaging(dir, LIMIT);
  expect(staging.captures.size).toBe(20);
  expect([...staging.captures.values()].every((c) => c.document !== undefined)).toBe(true);
  expect(staging.reporter).toEqual({ schemaVersion: "paneweft.vitest-report/1", tests: [] });
  expect(staging.typecheck).toEqual({ exitCode: 2, output: "error TS1" });
});

// Rejects: invocation records charged to the capture budget (the records of a long run starved the captures and the report).
it("[S39] reads every invocation record of a run whose records together exceed collectionBytes", async () => {
  const dir = await stage({ invocations: 12, captures: [9000], reporter: { tests: [] } });
  const staging = await readStaging(dir, LIMIT);
  expect(staging.invocations).toHaveLength(12);
  expect(staging.invocations.every((entry) => entry.started !== null && entry.completed !== null)).toBe(true);
  expect(staging.captures.get("inv-1")?.document).toBeDefined();
  expect(staging.reporter).toEqual({ tests: [] });
});

// The guarantee of the first fix, kept: a capture over collectionBytes is refused from fstat, before any read or parse.
it("[S39] refuses a sparse capture over collectionBytes from its size alone, without a read or a parse", async () => {
  const dir = await stage({});
  const big = join(dir, "captures", "inv-1.json");
  const file = await open(big, "w"); await file.truncate(256 * 1024 * 1024); await file.close();
  const probe = await open(big); const proto = Object.getPrototypeOf(probe); await probe.close();
  const read = vi.spyOn(proto, "read");
  const parse = vi.spyOn(JSON, "parse");
  const staging = await readStaging(dir, LIMIT);
  const capture = staging.captures.get("inv-1");
  expect([capture?.document, (capture?.bytes ?? 0) > LIMIT]).toEqual([undefined, true]);
  expect(read).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
});

// One capture over the limit is refused (quarantined by the caller) and spends nothing the other artifacts need.
it("[S39] refuses one capture over collectionBytes and leaves its neighbours and the native report alone", async () => {
  const dir = await stage({ captures: [LIMIT + 1, 4000, LIMIT], reporter: { tests: [] }, typecheck: { exitCode: 0, output: "" } });
  const staging = await readStaging(dir, LIMIT);
  const seen = Object.fromEntries([...staging.captures].map(([id, c]) => [id, [c.bytes > LIMIT, c.document !== undefined]]));
  expect(seen).toEqual({ "inv-1": [true, false], "inv-2": [false, true], "inv-3": [false, true] });
  expect(staging.reporter).toEqual({ tests: [] });
  expect(staging.typecheck).toEqual({ exitCode: 0, output: "" });
});

// The ceiling is real: it is derived from the count of captures, so a directory cannot make the host read without bound.
it("[S39] stops reading the non-capture artifacts at their fixed allowance", async () => {
  const dir = await stage({ captures: [100] });
  const huge = join(dir, "reporter.json");
  const file = await open(huge, "w"); await file.truncate(1024 * 1024 * 1024); await file.close();
  const staging = await readStaging(dir, LIMIT);
  expect(staging.reporter).toBeUndefined();
  expect(staging.captures.get("inv-1")?.document).toBeDefined();
});
