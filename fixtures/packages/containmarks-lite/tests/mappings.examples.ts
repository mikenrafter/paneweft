// Examples (spec section 3). The assertions are native vitest `expect`; cx.check records that the callback completed.
import { expect } from "vitest";
import { example, expectFailure, messageContains } from "@paneweft/sdk";
import { naiveParse, parseContainerMappingUrl } from "../src/mappings/containerMappings.ts";
import { Mapping } from "../src/mappings/containerMappings.paneweft.ts";

export const workMapping = example({
  id: "mapping.work",
  type: Mapping,
  claims: ["CM1"],
  run(cx) {
    const mapping = parseContainerMappingUrl("about:4:firefox-container-3:Work");
    cx.check("CM1", () => {
      expect(mapping).toEqual({ firstSeenIndex: 4, cookieStoreId: "firefox-container-3", backupName: "Work" });
    });
    return mapping!;
  },
});

export const renamedMapping = example({
  id: "mapping.renamed",
  type: Mapping,
  claims: ["CM2"],
  async run(cx) {
    const mapping = await cx.use(workMapping);
    const renamed = { ...mapping, backupName: "Research" };
    cx.check("CM2", () => {
      expect(renamed.cookieStoreId).toBe("firefox-container-3");
    });
    return renamed;
  },
});

/** Passes, returns a value and records no check: exploratory, never verified (IV6). */
export const zeroCheckMapping = example({
  id: "mapping.zero-check",
  type: Mapping,
  claims: [],
  run() {
    return parseContainerMappingUrl("about:1:firefox-container-1:Home")!;
  },
});

/** A dead end (spec S8, N4): splitting on every colon loses the rest of a name; the example passes when that failure reproduces. */
export const deadEndNaiveSplit = example({
  id: "mapping.dead-end.naive-split",
  type: Mapping,
  claims: ["CM-DE"],
  kind: "dead-end",
  async run() {
    await expectFailure(messageContains("backupName"), () => {
      expect(naiveParse("about:4:firefox-container-3:Work:Home")).toEqual({ firstSeenIndex: 4, cookieStoreId: "firefox-container-3", backupName: "Work:Home" });
    });
    return parseContainerMappingUrl("about:4:firefox-container-3:Work:Home")!;
  },
});
