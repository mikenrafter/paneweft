// Plain-DOM viewer (design section 5): renders validated view models only; labels, source text,
// Markdown and URLs are data. docs/viewer-dom-contract.md is normative for the DOM structure.
import type { EntityRef } from "../core/wire.ts";
import { initialInspectorState, type InspectorState } from "../core/inspector.ts";
import type { ViewerSource } from "./source.ts";

export interface MountOptions {
  source: ViewerSource;
  viewport: { width: number; height: number };
  locale: string;
  layoutVersion?: string;
}
export interface ViewerHandle {
  state(): InspectorState;
  openEntity(entity: EntityRef, snapshotId: string, preferredViewDefinitionId?: string): Promise<void>;
  /** Resolves when no render or source request is in flight. Tests await it after each event. */
  whenIdle(): Promise<void>;
  destroy(): void;
}

/** STUB: renders nothing. */
export async function mountViewer(container: HTMLElement, _options: MountOptions): Promise<ViewerHandle> {
  container.replaceChildren();
  return {
    state: () => initialInspectorState(),
    openEntity: async () => {},
    whenIdle: async () => {},
    destroy: () => container.replaceChildren(),
  };
}
