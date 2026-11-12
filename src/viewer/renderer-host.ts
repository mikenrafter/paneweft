// The browser side of a repo-owned renderer (spec section 5; amendments S4, N3): a sandboxed iframe, a private MessagePort, and the host's
// check of every message. The frame can name only the objects its view permits; the only action it can trigger is opening one of them in
// another pane. A protocol fault is shown, never swallowed, and an unexpected reload of the frame revokes the port.
import type { CustomRendering } from "../v1/serve-renderer.ts";
import { FRAME_MESSAGE_MAX_BYTES, RENDERER_IFRAME_SANDBOX, RENDERER_REFERRER_POLICY, validateFrameMessage, type FrameState } from "../v1/frame.ts";
import { h } from "./dom.ts";

export interface RendererHostOptions {
  doc: Document;
  custom: CustomRendering;
  /** The stored view id and snapshot id the frame is bound to (every frame message must carry them). */
  viewId: string;
  snapshotId: string;
  locale: string;
  /** The standard component for the same facts: always rendered, so an agent or a person can read them whatever the frame does. */
  fallback: Node[];
  /** The frame asked to open this object (already checked against the view's permitted objects). */
  openObject(objectId: string): void;
}

const WINDOW_MS = 1000;
const MAX_FRAME_HEIGHT = 1200;

export function renderRendererHost(options: RendererHostOptions): HTMLElement {
  const { doc, custom } = options;
  const win = doc.defaultView as Window & typeof globalThis;
  const notice = h(doc, "div", { "data-pw": "renderer-notice", role: "status" }) as HTMLElement;
  notice.hidden = true;
  const fallback = h(doc, "details", { "data-pw": "renderer-fallback-holder", ...(custom.state === "ready" ? {} : { open: "" }) }, h(doc, "summary", {}, "Standard view of the same facts"), h(doc, "div", { "data-pw": "renderer-fallback" }, ...options.fallback));
  const host = h(doc, "div", { "data-pw": "renderer-host", "data-state": custom.state }, notice) as HTMLElement;

  let rejected = 0;
  let lastRejection = "";
  let revoked = false;
  let renderError: string | null = null;
  const updateNotice = (): void => {
    const state = revoked ? "revoked" : rejected > 0 ? "protocol-error" : renderError !== null ? "failed" : custom.state === "ready" ? null : custom.state;
    notice.hidden = state === null;
    if (state === null) return;
    notice.setAttribute("data-state", state);
    notice.setAttribute("data-rejected", String(rejected));
    notice.textContent = revoked ? `The renderer was disconnected: ${renderError ?? "its frame reloaded itself"}. ${rejected} message(s) were rejected. The standard view below is unaffected.`
      : rejected > 0 ? `The renderer sent ${rejected} message(s) the viewer rejected (last: ${lastRejection}). Nothing they asked for was done.`
        : renderError !== null ? `The renderer reported an error: ${renderError}`
          : custom.message;
  };
  updateNotice();

  if (custom.state === "ready" && custom.frame !== undefined) {
    const info = custom.frame;
    const permitted = Object.keys(info.objects);
    const frame = h(doc, "iframe", { "data-pw": "renderer-frame", sandbox: RENDERER_IFRAME_SANDBOX, referrerpolicy: RENDERER_REFERRER_POLICY, src: info.src, title: `${custom.renderer.id} renderer`, style: "width:100%;border:0;height:96px" }) as HTMLIFrameElement;
    let loads = 0;
    let port: MessagePort | null = null;
    let handshakeDone = false;
    let highestSeq = 0;
    let state: FrameState = { frameId: info.frameId, nonce: info.nonce, viewId: options.viewId, snapshotId: options.snapshotId, permittedObjects: permitted, lastSeq: 0, closed: false, requestsInWindow: 0 };
    const recent: number[] = [];
    let hostSeq = 0;
    const send = (type: string, body: unknown): void => {
      hostSeq += 1;
      port?.postMessage({ protocol: 1, type, frameId: info.frameId, viewId: options.viewId, snapshotId: options.snapshotId, requestId: `h${hostSeq}`, seq: hostSeq, body });
    };
    const revoke = (why: string): void => {
      revoked = true;
      renderError = why;
      state = { ...state, closed: true };
      port?.close();
      port = null;
      updateNotice();
    };
    const onMessage = (data: unknown): void => {
      if (revoked) return;
      const now = Date.now();
      while (recent.length > 0 && now - (recent[0] as number) > WINDOW_MS) recent.shift();
      const verdict = validateFrameMessage({ ...state, lastSeq: Math.max(state.lastSeq, highestSeq), requestsInWindow: recent.length }, data, { windowMatches: true, handshakeDone });
      recent.push(now);
      const seq = (data as { seq?: unknown } | null)?.seq;
      if (typeof seq === "number" && Number.isInteger(seq) && seq > highestSeq) highestSeq = seq;
      if (!verdict.accept) {
        rejected += 1;
        lastRejection = verdict.reason;
        if (verdict.revokePort) revoke(`message rejected: ${verdict.reason}`);
        else updateNotice();
        return;
      }
      state = verdict.state;
      const message = data as { type: string; body?: Record<string, unknown> };
      const body = message.body ?? {};
      switch (message.type) {
        case "ready":
          handshakeDone = true;
          send("init", { payload: info.payload, objects: permitted, theme: "light", locale: options.locale, label: `${custom.renderer.id} renderer` });
          break;
        case "open_object":
          options.openObject(String(body.object));
          break;
        case "resize": {
          const height = Number(body.height);
          if (Number.isFinite(height)) frame.style.height = `${Math.max(40, Math.min(MAX_FRAME_HEIGHT, Math.round(height)))}px`;
          break;
        }
        case "render_error":
          renderError = String(body.message ?? "unknown error").slice(0, 300);
          updateNotice();
          break;
        default:
          break; // select_item and request_page need no host action in week one
      }
    };
    frame.addEventListener("load", () => {
      loads += 1;
      if (loads > 1) {
        revoke("its frame reloaded itself");
        return;
      }
      const channel = new win.MessageChannel();
      port = channel.port1;
      port.onmessage = (event: MessageEvent) => onMessage(event.data);
      frame.contentWindow?.postMessage({ protocol: 1, type: "bootstrap", nonce: info.nonce, frameId: info.frameId, viewId: options.viewId, snapshotId: options.snapshotId }, "*", [channel.port2]);
    });
    host.append(frame);
  }
  host.append(fallback);
  void FRAME_MESSAGE_MAX_BYTES;
  return host;
}
