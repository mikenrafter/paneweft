// The SHIPPED viewer bundle (dist/viewer, built by test/global-setup.ts) running in JSDOM against a REAL viewer server: fetch goes over a real
// socket with the server's own token, so what is asserted is what a browser user would get. Used by suites that must prove behaviour "through
// the shipped bundle" (reviews S4, S8, S9).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, vi } from "vitest";
import { DIST_VIEWER } from "./wire-http.ts";

export interface ViewerPage {
  window: JSDOM["window"];
  /** Elements with data-pw=`name`. */
  pw(name: string): HTMLElement[];
  /** Whitespace-normalised text of an element. */
  text(element: Element | null | undefined): string;
  /** Re-runs `check` until it stops throwing (bounded at 5 s; the responses arrive over real sockets, no clock is involved). */
  settled<T>(check: () => T): Promise<T>;
  key(element: HTMLElement, key: string): void;
}

export function useViewerDom(): (server: { origin: string; token: string }, view: string, snapshot: string) => ViewerPage {
  const windows: JSDOM["window"][] = [];
  afterEach(() => { for (const window of windows.splice(0)) window.close(); });
  return (server, view, snapshot) => {
    const html = readFileSync(join(DIST_VIEWER, "index.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
    const dom = new JSDOM(html, { url: `${server.origin}/#token=${server.token}&view=${encodeURIComponent(view)}&snapshot=${encodeURIComponent(snapshot)}`, runScripts: "outside-only", pretendToBeVisual: true });
    (dom.window as unknown as { fetch: typeof fetch }).fetch = (input, init) => fetch(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, dom.window.location.href), init);
    dom.window.eval(readFileSync(join(DIST_VIEWER, "app.js"), "utf8"));
    windows.push(dom.window);
    return {
      window: dom.window,
      pw: (name) => Array.from(dom.window.document.querySelectorAll<HTMLElement>(`[data-pw="${name}"]`)),
      text: (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim(),
      settled: (check) => vi.waitFor(check, { timeout: 5000, interval: 20 }),
      key(element, key) {
        element.focus();
        element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      },
    };
  };
}
