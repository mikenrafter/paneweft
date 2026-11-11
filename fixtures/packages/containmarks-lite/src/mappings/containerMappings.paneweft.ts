// Development-only instrumentation: imported by tests and the development entry, never by production code.
import { defineType } from "@paneweft/sdk";
import type { ContainerMappingRecord } from "../models.ts";

export const Mapping = defineType<ContainerMappingRecord>({
  id: "containmarks::ContainerMappingRecord",
  source: { path: "src/models.ts", symbol: "ContainerMappingRecord" },
});

export const mappingDetails = Mapping.view({
  id: "mapping.details",
  title: "Container mapping",
  question: "Which original index and container does this mapping preserve?",
  priority: 10,
  component: "shape",
  render(mapping, view) {
    return view.details().field("original index", mapping.firstSeenIndex).field("container ID", mapping.cookieStoreId).field("backup name", mapping.backupName).done();
  },
});
