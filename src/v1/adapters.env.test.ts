// The `env` member of an adapter record is validated like the rest of the record (F21): names are variable names, PANEWEFT_* is the collector's, values are bounded.
import { describe, expect, it } from "vitest";
import { must, mustFail } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { loadAdapters, registerAdapter, type AdapterRecord } from "./adapters.ts";

const tmp = useTempDirs();
const cargo = { schemaVersion: "paneweft.adapter/1", id: "cargo", kind: "cargo", grammar: "cargo-test/1", repo: "vg", executable: process.execPath, workspaceRoot: "/work/vigil", entry: ".", features: ["paneweft"], supportedVersions: ["1.97"], limits: { timeoutMs: 60000, logBytes: 65536 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" } } as AdapterRecord;

describe("[F21] the adapter env member", () => {
  // why: F21. The record may fix variables and name passthrough variables; a name the collector owns, a name that is not a variable name, a non-string value and a duplicate are refused.
  // proves: CLAIM(F21-adapter-env)
  it("accepts fixed and passthrough names and refuses the rest", async () => {
    const dir = tmp("adapter-env");
    const good = { ...cargo, env: { set: { RUSTUP_HOME: "/usr/local/rustup" }, passthrough: ["MY_TOOL_HOME"] } };
    must(await registerAdapter(dir, good), "register");
    expect(must(await loadAdapters(dir), "load")).toEqual([good]);
    for (const [label, env] of [["PANEWEFT_ in set", { set: { PANEWEFT_RUN_ID: "x" } }], ["PANEWEFT_ in passthrough", { passthrough: ["PANEWEFT_STAGING_DIR"] }], ["bad name", { set: { "A B": "x" } }], ["non-string value", { set: { A: 1 } }], ["duplicate passthrough", { passthrough: ["A", "A"] }], ["unknown member", { shell: "bash" }]] as const) {
      expect(mustFail(await registerAdapter(dir, { ...cargo, env }), label).code, label).toBe("VALIDATION_FAILED");
    }
  });
});
