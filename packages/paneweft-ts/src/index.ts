// @paneweft/sdk. RED PHASE: signatures are the contract, bodies are compile-only stubs (grep NOT_IMPLEMENTED).
// The sentinel lets a bundle check prove that a production bundle does not contain the SDK (IV4).
export const PANEWEFT_SDK_SENTINEL = "paneweft-sdk-sentinel-7f3a91";

export * from "./builders.ts";
export * from "./capture.ts";
export * from "./example.ts";
export * from "./limits.ts";
export * from "./manifest.ts";
export * from "./trail.ts";
export * from "./types.ts";
export * from "./values.ts";
export { stagingFromEnv, ENV, type Staging } from "./artifacts.ts";
