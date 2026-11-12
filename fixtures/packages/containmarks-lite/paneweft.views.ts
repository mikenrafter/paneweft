// The explicit import manifest (spec section 2): module exports and example definitions are listed here, not discovered.
import { defineManifest } from "@paneweft/sdk";
import { Mapping, mappingDetails, mappingCard } from "./src/mappings/containerMappings.paneweft.ts";
import { deadEndNaiveSplit, renamedMapping, workMapping, zeroCheckMapping } from "./tests/mappings.examples.ts";

export const manifest = defineManifest({
  runners: ["vitest"],
  modules: [
    { path: "src/mappings/containerMappings.paneweft.ts", types: [Mapping], views: [mappingDetails, mappingCard] },
    { path: "tests/mappings.examples.ts", examples: [workMapping, renamedMapping, zeroCheckMapping, deadEndNaiveSplit] },
  ],
});
