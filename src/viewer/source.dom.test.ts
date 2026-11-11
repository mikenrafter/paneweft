// @vitest-environment jsdom
// MC6 (browser side): source anchors open the right stored bytes and line numbers. A temporary git repository holds
// src/check.ts exactly as committed in fixtures/goldens/repo (sha256 89e5381d...); the source view records that hash and the
// excerpt lines [10,12]. The viewer runs over the REAL session source (no freshness decorator): currency comes from the
// registered root, as in production. Texts: dom.md D (source-origin, annotation, stale-notice, unknown-notice).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUBJECT, byId, checkTs, click, goldenBundle, ids, need, openBundle, openEntity, ownText, qa, q, text, useViewerCleanup, type MountedViewer,
} from "../../test/helpers/dom-harness.ts";
import { initGitRepo } from "../../test/helpers/git.ts";
import { patch } from "../../test/helpers/patch.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

interface Repo { root: string; head: string }
function makeRepo(): Repo {
  const root = tmp("repo");
  const head = initGitRepo(root, { "src/check.ts": checkTs() });
  return { root, head };
}
async function openSource(repo: Repo | null, registered = true): Promise<MountedViewer> {
  const bundle = repo === null ? goldenBundle("source") : patch(goldenBundle("source"), { op: "replace", path: "/views/0/freshness/repositories/0/gitRev", value: repo.head });
  return openBundle(tmp("session"), bundle, SUBJECT, "d-code", { repositories: repo !== null && registered ? [{ id: "r", root: repo.root }] : [] });
}
const lines = (v: MountedViewer) => qa(v.container, "source-line").map((l) => ({ line: l.getAttribute("data-line"), highlighted: l.getAttribute("data-highlighted"), code: ownText(l) }));

describe("[MC6] source click-through in the browser", () => {
  // why: design 7 MC6 "Click an annotation through the real browser route; assert repository, revision, numbered lines, and highlighted range."
  // proves: CLAIM(MC6)
  it("[MC6] activating annotation a1 shows source-origin (repository, revision, path) and file-numbered lines 10-12 with only 11-12 highlighted", async () => {
    const repo = makeRepo();
    const v = await openSource(repo);
    // before activation nothing is highlighted (negative control for the highlight rule)
    expect(lines(v).map((l) => l.highlighted)).toEqual(["false", "false", "false"]);
    await click(v, byId(v.container, "annotation", "a1"));
    // expected: the excerpt anchor is lines [10,12] of check.ts; annotation a1 covers [11,12] (fixtures/goldens/source.bundle.json)
    expect(lines(v)).toEqual([
      { line: "10", highlighted: "false", code: "export function check(user: User) {" },
      { line: "11", highlighted: "true", code: "if (!allowed(user)) return denied;" },
      { line: "12", highlighted: "true", code: "audit(user);" },
    ]);
    expect(text(need(v.container, "source-origin"))).toBe(`r ${repo.head} src/check.ts`);
    expect(qa(v.container, "line-number").map((n) => text(n))).toEqual(["10", "11", "12"]);
    expect(q(v.container, "stale-notice")).toBeNull();
    expect(q(v.container, "unknown-notice")).toBeNull();
  });
  // why: only the activated annotation's lines are highlighted: activating a2 moves the highlight rather than adding to it.
  // proves: CLAIM(MC6)
  it("[MC6] activating a2 (line 10) after a1 moves the highlight: only line 10 is highlighted", async () => {
    const v = await openSource(makeRepo());
    await click(v, byId(v.container, "annotation", "a1"));
    await click(v, byId(v.container, "annotation", "a2"));
    expect(lines(v).map((l) => [l.line, l.highlighted])).toEqual([["10", "true"], ["11", "false"], ["12", "false"]]);
  });
  // why: each annotation button states its lines and message and claim ids (contract Source: data-lines = a-b; text = message and claim ids).
  // proves: CLAIM(MC6)
  it("[MC6] annotations expose data-lines and \"message (claims: ids)\"; the claim-less one shows only its message", async () => {
    const v = await openSource(makeRepo());
    expect(qa(v.container, "annotation").map((a) => [a.getAttribute("data-id"), a.getAttribute("data-lines"), text(a), a.tagName])).toEqual([
      ["a1", "11-12", "Denial branch (claims: C1)", "BUTTON"],
      ["a2", "10-10", "Entry point", "BUTTON"],
    ]);
  });
  // why: design 4 "If local bytes no longer match the recorded hash, click-through offers the stored excerpt and identifies the mismatch."
  // proves: CLAIM(MC6)
  it("[MC6] after the file changes on disk, re-opening shows a stale-notice naming the hash mismatch while the stored (old) excerpt is still shown", async () => {
    const repo = makeRepo();
    const v = await openSource(repo);
    await click(v, byId(v.container, "annotation", "a1"));
    expect(q(v.container, "stale-notice"), "negative control: unchanged bytes are not stale").toBeNull();
    writeFileSync(join(repo.root, "src", "check.ts"), checkTs().replace("return denied;", "return granted;"));
    await openEntity(v, SUBJECT, "d-code");
    await click(v, byId(v.container, "annotation", "a1"));
    const notice = need(v.container, "stale-notice");
    expect(text(notice)).toMatch(/hash/i);
    expect(text(notice)).toMatch(/mismatch/i);
    expect(text(notice)).toMatch(/stored excerpt/i);
    expect(lines(v)[1]).toEqual({ line: "11", highlighted: "true", code: "if (!allowed(user)) return denied;" });
    expect(qa(v.container, "source-line").map((l) => text(l)).join("\n")).not.toContain("granted");
    expect(q(v.container, "unknown-notice")).toBeNull();
  });
  // why: design 4 "Unknown ... with inaccessible roots": an unregistered repository gives unknown currency, never a guess, and keeps the excerpt.
  // proves: CLAIM(MC6)
  it("[MC6] with no registered root the currency is unknown: unknown-notice says so, the stored excerpt is shown, there is no stale-notice", async () => {
    const v = await openSource(makeRepo(), false);
    await click(v, byId(v.container, "annotation", "a1"));
    const notice = need(v.container, "unknown-notice");
    expect(text(notice)).toMatch(/unknown/i);
    expect(q(v.container, "stale-notice")).toBeNull();
    expect(ids(qa(v.container, "source-line"), "data-line")).toEqual(["10", "11", "12"]);
    expect(lines(v)[2]).toEqual({ line: "12", highlighted: "true", code: "audit(user);" });
  });
  // why: a non-Git root has gitRev null; the origin must say "no revision" instead of an empty or fabricated revision.
  // proves: CLAIM(MC6)
  it("[MC6] a source recorded without a Git revision reads \"no revision\" in source-origin", async () => {
    const v = await openSource(null);
    await click(v, byId(v.container, "annotation", "a1"));
    expect(text(need(v.container, "source-origin"))).toBe("r no revision src/check.ts");
  });
});
