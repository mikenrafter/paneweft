// Browser entry bundled by scripts/build-viewer.mjs into dist/viewer/app.js.
// Exposes window.paneweft.mountViewer and, when the page URL carries #token=...&view=...&snapshot=..., boots the viewer on #root
// over the page's own origin (dom.md A2). The token travels in the URL fragment only and is sent as a bearer header.
import { mountViewer } from "./mount.ts";
import { createHttpSource } from "./http-source.ts";

declare global {
  interface Window { paneweft?: { mountViewer: typeof mountViewer } }
}

window.paneweft = { mountViewer };

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token");
  const root = document.getElementById("root");
  if (token === null || root === null) return;
  const source = createHttpSource(window.location.origin, token);
  const viewer = await mountViewer(root, {
    source, locale: navigator.language || "en-US", editable: true,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  const viewId = params.get("view");
  const snapshotId = params.get("snapshot");
  if (viewId === null || snapshotId === null) return;
  const model = await source.getView({ viewId, snapshotId });
  if (!model.ok) {
    root.append(Object.assign(document.createElement("div"), { textContent: `${model.error.code}: ${model.error.message}` }));
    return;
  }
  await viewer.openEntity(model.value.envelope.entity, snapshotId, model.value.envelope.viewDefinitionId);
}

void boot();
