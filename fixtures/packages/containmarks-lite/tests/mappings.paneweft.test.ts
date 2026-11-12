import { exampleTest } from "@paneweft/sdk/vitest";
import { deadEndNaiveSplit, renamedMapping, workMapping, zeroCheckMapping } from "./mappings.examples.ts";

exampleTest(workMapping);
exampleTest(renamedMapping);
exampleTest(zeroCheckMapping);
exampleTest(deadEndNaiveSplit);
