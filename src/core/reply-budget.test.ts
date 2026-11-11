// why: review S3. The exit-budget suite proves the transports; this file pins the pieces, including the success-path replacement that no
// shipped operation can reach today (their schemas bound those replies) but that the shared exit must still guarantee (CLAIM(bounded-exit)).
// Expected values are hand-derived: "€" is 3 UTF-8 bytes, "😀" is 4; a budget below the 2048 floor is lifted to it; the default is 8192.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { enforceReplyBudget, type OperationOutcome } from "./operations.ts";
import { boundError, boundSuccessBody, byteLength, prefixWithin, replyBudget } from "./reply-budget.ts";
import type { OperationError } from "./errors.ts";

describe("replyBudget", () => {
  it.each([
    [undefined, 8192], ["2048", 8192], [2048.5, 8192], [null, 8192], // not an integer: the default
    [2048, 2048], [4000, 4000], [32768, 32768], // in range: as asked
    [100, 2048], [-5, 2048], // below the floor: the floor
    [40_000, 32768], // above the maximum: the maximum
  ])("%j -> %i", (maxBytes, expected) => {
    expect(replyBudget(maxBytes)).toBe(expected);
  });
});

describe("prefixWithin", () => {
  // why: a cut inside a code point would produce U+FFFD or an invalid body. Fixed cases: 3-byte and 4-byte characters at every offset.
  it.each([["€€€", 4, "€"], ["😀😀", 7, "😀"], ["ab€", 3, "ab"], ["abc", 3, "abc"], ["abc", 0, ""]])("%j within %i bytes is %j", (text, limit, expected) => {
    expect(prefixWithin(text, limit)).toBe(expected);
  });
  it("never splits a code point and never exceeds the limit (property)", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 0, max: 64 }), (text, limit) => {
      const prefix = prefixWithin(text, limit);
      return byteLength(prefix) <= limit && text.startsWith(prefix) && !prefix.includes("�");
    }), { seed: 20260611, numRuns: 300 });
  });
});

describe("boundError", () => {
  const error = (overrides: Partial<OperationError>): OperationError => ({ schemaVersion: "paneweft.error/1", code: "VALIDATION_FAILED", message: "m", errors: [], retryable: false, ...overrides });

  // why: control characters expand six-fold when JSON-escaped, so a message clipped by raw bytes can still bust the budget; the clip must shrink until the SERIALIZED body fits.
  it("a message of control characters is shrunk until the serialized body fits the floor", () => {
    const bounded = boundError(error({ message: "\u0001".repeat(5000) }), 2048);
    expect(byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(2048);
    expect(bounded.message.length).toBeGreaterThan(0);
    expect((bounded.details?.truncated as { messageBytesOmitted: number }).messageBytesOmitted).toBeGreaterThan(0);
  });

  // why: large `details` must not crowd out the code and issues; they are dropped and the drop is stated.
  it("oversized details are dropped and stated; retryable and code are kept", () => {
    const bounded = boundError(error({ code: "CONFLICT", retryable: true, details: { big: "x".repeat(5000) } }), 2048);
    expect(bounded).toMatchObject({ code: "CONFLICT", retryable: true, details: { truncated: { detailsOmitted: true } } });
    expect(bounded.details).not.toHaveProperty("big");
  });

  // control: small details survive a bounding caused by something else.
  it("small details are kept next to the truncation record", () => {
    const issues = Array.from({ length: 100 }, (_, index) => ({ code: "REQUIRED" as const, pointer: `/p${index}`, constraint: "required: x".padEnd(200, "."), hint: "supply it".padEnd(200, ".") }));
    const bounded = boundError(error({ code: "CONFLICT", details: { currentRevision: 7 }, errors: issues }), 2048);
    expect(bounded.details).toMatchObject({ currentRevision: 7, truncated: { errorsTotal: 100 } });
    expect(bounded.errors.length).toBeGreaterThan(0);
    expect(bounded.errors.length).toBeLessThan(100);
  });
});

describe("enforceReplyBudget on a successful reply", () => {
  const big = (format: "text" | "json"): OperationOutcome => ({ ok: true, format, body: "€".repeat(4000), payload: {}, cursor: "next" });

  // why: derivation: 4000 "€" = 12000 bytes > 2048, so the reply must be replaced; the result stays within 2048, states the omitted byte count
  //      (total 12000 minus the kept excerpt) and drops the cursor, because re-running the operation would repeat its effect.
  it.each(["text", "json"] as const)("%s: replaced by a truncated reply within 2048 bytes that states what was omitted", (format) => {
    const bounded = enforceReplyBudget(big(format), 2048, "validate");
    expect(bounded.ok).toBe(true);
    expect(byteLength(bounded.body)).toBeLessThanOrEqual(2048);
    const payload = (bounded as Extract<OperationOutcome, { ok: true }>).payload as { totalBytes: number; omittedBytes: number; excerpt: string; operation: string };
    expect(payload).toMatchObject({ schemaVersion: "paneweft.truncated/1", operation: "validate", complete: false, totalBytes: 12000 });
    expect(payload.omittedBytes).toBe(12000 - byteLength(payload.excerpt));
    expect(payload.excerpt).toBe("€".repeat(payload.excerpt.length));
    if (format === "json") expect(JSON.parse(bounded.body)).toEqual(payload);
    else expect(bounded.body).toContain(`[truncated: ${payload.omittedBytes} of 12000 bytes omitted`);
    expect((bounded as Extract<OperationOutcome, { ok: true }>).cursor).toBeNull();
  });

  it("control: a reply that fits is returned untouched (same object)", () => {
    const small: OperationOutcome = { ok: true, format: "text", body: "fits\n", payload: {}, cursor: null };
    expect(enforceReplyBudget(small, 2048, "validate")).toBe(small);
  });

  it("boundSuccessBody keeps the largest excerpt that fits (one more byte would not)", () => {
    const body = "€".repeat(4000);
    const { payload } = boundSuccessBody(body, "json", "x", 2048);
    const excerpt = (payload as { excerpt: string }).excerpt;
    const longer = boundSuccessBody(body, "json", "x", 2048 + 3); // three more bytes admit exactly one more character
    expect((longer.payload as { excerpt: string }).excerpt.length).toBe(excerpt.length + 1);
  });
});
