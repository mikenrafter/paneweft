// Review S3: the byte budget was enforced only by the pager. Failure bodies (echoed names, one issue per fault) and successful replies that
// do not page left executeOperation unbounded: a 3000-character unknown operation name came back as 3326 bytes at maxBytes 2048.
// The budget must hold at the ONE exit every operation shares, with bounded diagnostics and explicit omission metadata, over every transport:
// executeOperation, the CLI (`validate`, `example run`) and the stdio MCP server.
// Placement: cross-transport on purpose (the claim is "all exits"), so this suite is not beside a single module.
// Oracles: the fault list is the one validateSubmission itself reports for the same input (kept issues must be a prefix of it, in order);
// sizes are measured with Buffer.byteLength on the bytes actually returned.
// proves: CLAIM(MC3) CLAIM(bounded-exit)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSubmission } from "./validate.ts";
import { ERROR_SCHEMA, callOperation, validateAgainst } from "../../test/helpers/ops-env.ts";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { connectMcp } from "../../test/helpers/mcp-client.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** An envelope-shaped document with 300 unknown properties: each is one UNKNOWN_PROPERTY fault, so the report is far larger than any budget. */
const manyFaults = (): Record<string, unknown> => {
  const input: Record<string, unknown> = { schemaVersion: "paneweft.view/1" };
  for (let index = 0; index < 300; index += 1) input[`unexpected${String(index).padStart(3, "0")}`] = index;
  return input;
};
const oracleIssues = (input: unknown) => {
  const report = validateSubmission(input);
  if (report.ok) throw new Error("the fault fixture must fail validation");
  return report.errors;
};

interface Truncated { errorsTotal: number; errorsOmitted: number; messageBytesOmitted: number; continuation: string }
const bodyOf = (text: string): { code: string; message: string; errors: Array<Record<string, string>>; retryable: boolean; details?: { truncated?: Truncated } } => JSON.parse(text);

describe("[S3] executeOperation holds the byte budget at its exit", () => {
  // why: the unknown-operation message echoes the name; 3000 characters of it exceeded the 2048-byte budget (3326 bytes observed).
  it.each([["a", 3000], ["€", 1000]] as const)("an unknown operation named with %s x %i is a bounded UNKNOWN_OPERATION", async (unit, count) => {
    const name = unit.repeat(count);
    const outcome = await callOperation(null, name, { maxBytes: 2048 });
    expect(bytes(outcome.body), "body bytes").toBeLessThanOrEqual(2048);
    const body = bodyOf(outcome.body);
    expect(body.code).toBe("UNKNOWN_OPERATION");
    expect(validateAgainst(ERROR_SCHEMA, body)).toEqual([]);
    expect(body.message.startsWith(`unknown operation "${unit.repeat(20)}`)).toBe(true);
    expect(body.details?.truncated?.messageBytesOmitted, "the omission is stated").toBeGreaterThan(0);
  });

  // why: validation reports one issue per fault; hundreds of faults at once must be cut to what fits, in order, and the cut must be stated.
  it.each([["text", 2048], ["json", 2048], ["text", 8192], ["json", 32768]] as const)("300 simultaneous validation faults, %s at maxBytes %i: within budget, an in-order prefix, omission counted", async (format, maxBytes) => {
    const input = manyFaults();
    const oracle = oracleIssues(input);
    expect(oracle.length, "the fixture must exceed any budget, or the test is vacuous").toBeGreaterThanOrEqual(300);
    const outcome = await callOperation(null, "validate", { input, format, maxBytes });
    expect(outcome.ok).toBe(false);
    expect(bytes(outcome.body), "body bytes").toBeLessThanOrEqual(maxBytes);
    const body = bodyOf(outcome.body);
    expect(validateAgainst(ERROR_SCHEMA, body)).toEqual([]);
    expect(body.errors.length, "at least the first fault is always reported").toBeGreaterThanOrEqual(1);
    expect(body.errors).toEqual(oracle.slice(0, body.errors.length).map((issue) => ({ ...issue })));
    expect(body.details?.truncated).toMatchObject({ errorsTotal: oracle.length, errorsOmitted: oracle.length - body.errors.length });
    expect(typeof body.details?.truncated?.continuation).toBe("string");
  });

  // control: bounding must not touch a reply that already fits, or every error would lose information.
  it("control: a few faults at a roomy budget are returned whole and unmarked", async () => {
    const input = { schemaVersion: "paneweft.view/1", unexpectedA: 1, unexpectedB: 2 };
    const oracle = oracleIssues(input);
    expect(oracle.length, "small enough to fit 8192 bytes whole").toBeLessThan(40);
    const outcome = await callOperation(null, "validate", { input, maxBytes: 8192 });
    const body = bodyOf(outcome.body);
    expect(body.errors).toEqual(oracle.map((issue) => ({ ...issue })));
    expect(body.details?.truncated).toBeUndefined();
  });
});

describe("[S3] the CLI holds the budget on every failure exit", () => {
  // why: `validate` prints the operation body; `example run` printed result.error directly, bypassing the operation exit.
  it("validate with 300 faults and --max-bytes 2048 prints at most 2048 bytes", async () => {
    const run = await runCliInProcess(["validate", "--args", JSON.stringify({ input: manyFaults() }), "--max-bytes", "2048"]);
    expect(run.exitCode).toBe(1);
    expect(bytes(run.stdout)).toBeLessThanOrEqual(2048);
    expect(bodyOf(run.stdout).details?.truncated?.errorsTotal).toBeGreaterThanOrEqual(300);
  });

  it("example run with a 10000-character runner id prints a body within the default 8192-byte budget", async () => {
    const dir = tmp("exit-budget-cli");
    const registry = join(dir, "runners.json");
    writeFileSync(registry, JSON.stringify({ runners: [] }));
    const run = await runCliInProcess(["--session", join(dir, "session"), "example", "run", "r".repeat(10_000), "--runners", registry, "--view", "v", "--snapshot", "s"]);
    expect(run.exitCode).toBe(1);
    expect(bodyOf(run.stdout).code).toBe("RUNNER_NOT_FOUND");
    expect(bytes(run.stdout)).toBeLessThanOrEqual(8192);
  });
});

describe("[S3] the MCP server holds the budget on every failure exit", () => {
  it("validate with 300 faults and maxBytes 2048, and a 3000-character unknown tool name, answer within 2048 bytes", async () => {
    const mcp = await connectMcp(null);
    try {
      const faults = await mcp.call("validate", { input: manyFaults(), maxBytes: 2048 });
      expect(faults.isError).toBe(true);
      expect(bytes(faults.text)).toBeLessThanOrEqual(2048);
      expect(bodyOf(faults.text).details?.truncated?.errorsTotal).toBeGreaterThanOrEqual(300);
      const unknown = await mcp.call("u".repeat(3000), { maxBytes: 2048 });
      expect(unknown.isError).toBe(true);
      expect(bytes(unknown.text)).toBeLessThanOrEqual(2048);
      expect(bodyOf(unknown.text).code).toBe("UNKNOWN_OPERATION");
    } finally {
      await mcp.close();
    }
  });
});
