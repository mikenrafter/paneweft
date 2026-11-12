// Development-only instrumentation: imported by tests and the development entry, never by production code.
import { defineType, defineRenderer } from "@paneweft/sdk";
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

const cardRenderer = defineRenderer<{ originalIndex: number; containerId: string; backupName: string }>({
  id: "mapping-card", apiVersion: 1,
  assetDigest: "0f2a69c4a3f2e64caea0ecd15424171f1ba679bc832291aafb95fac8f2876d7d",
  payloadSchemaDigest: "c0dbe898989f5e51466065b904b2d88ef029914981ff986e84aa7fe46f4fae0e",
});
export const mappingCard = Mapping.view({
  id: "mapping.card", title: "Mapping card", question: "Which original index and container does this mapping preserve?", priority: 20, component: "custom",
  render(mapping, view) {
    const fallback = view.details().field("original index", mapping.firstSeenIndex).field("container ID", mapping.cookieStoreId).field("backup name", mapping.backupName).done();
    return view.custom(cardRenderer, { originalIndex: mapping.firstSeenIndex, containerId: mapping.cookieStoreId, backupName: mapping.backupName }, fallback, [view.self()]);
  },
});
