// The production entry point: it must never import the manifest or the instrumentation files (IV4).
export { parseContainerMappingUrl } from "./mappings/containerMappings.ts";
export type { ContainerMappingRecord } from "./models.ts";
