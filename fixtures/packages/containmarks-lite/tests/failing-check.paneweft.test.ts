// SEEDED FAILURE (native failure): the recorded check fails. Run only when selected by file.
import { expect } from "vitest";
import { example } from "@paneweft/sdk";
import { exampleTest } from "@paneweft/sdk/vitest";
import { parseContainerMappingUrl } from "../src/mappings/containerMappings.ts";
import { Mapping } from "../src/mappings/containerMappings.paneweft.ts";

export const swappedMapping = example({
  id: "mapping.seeded-failure",
  type: Mapping,
  claims: ["CM-SEED"],
  run(cx) {
    const mapping = parseContainerMappingUrl("about:4:firefox-container-3:Work")!;
    cx.check("CM-SEED", () => {
      expect(mapping.firstSeenIndex).toBe(5);
    });
    return mapping;
  },
});

exampleTest(swappedMapping);
