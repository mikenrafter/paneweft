// WHY CLAIM(S27): stat rejection and bounded reads must precede parsing, and the allowance belongs to all staged artifacts together.
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { StagingBudget } from "./bounded-read.ts";
const tmp = useTempDirs();
afterEach(() => vi.restoreAllMocks());
it("[S27] refuses a sparse oversized file before reading or parsing it", async () => {
  const dir = tmp("bounded-read"); const small = join(dir, "small"); const huge = join(dir, "huge");
  await writeFile(small, '{"ok":true}');
  const file = await open(huge, "w"); await file.truncate(128 * 1024 * 1024); await file.close();
  const probe = await open(small); const proto = Object.getPrototypeOf(probe); await probe.close();
  const read = vi.spyOn(proto, "read"); const parse = vi.spyOn(JSON, "parse");
  expect(await new StagingBudget(1024).json(small)).toEqual({ ok: true });
  expect(read).toHaveBeenCalled(); expect(parse).toHaveBeenCalled();
  read.mockClear(); parse.mockClear();
  await expect(new StagingBudget(1024).json(huge)).rejects.toThrow(/staging budget/);
  expect(read).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
});
it("[S27] rejects a file that grows after stat without parsing the overrun", async () => {
  const file = join(tmp("growing-read"), "capture"); await writeFile(file, '{}');
  const probe = await open(file); const proto = Object.getPrototypeOf(probe); await probe.close();
  const original = proto.stat;
  vi.spyOn(proto, "stat").mockImplementation(async function(this: object) { const stat = await original.call(this); await writeFile(file, ' '.repeat(4096)); return stat; });
  const parse = vi.spyOn(JSON, "parse");
  await expect(new StagingBudget(1024).json(file)).rejects.toThrow(/grew beyond/);
  expect(parse).not.toHaveBeenCalled();
});
it("[S27] charges original file bytes to one aggregate staging allowance", async () => {
  const file = join(tmp("aggregate-read"), "capture"); await writeFile(file, ' '.repeat(598) + '{}');
  const budget = new StagingBudget(1000);
  expect(await budget.jsonWithBytes(file)).toEqual({ document: {}, bytes: 600 });
  await expect(budget.json(file)).rejects.toThrow(/400 bytes/);
});
