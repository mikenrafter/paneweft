// Sanitised Markdown for notebook prose (design section 5: "sanitize Markdown; forbid embedded
// scripts, raw event handlers, and arbitrary HTML renderers").
// Contract (docs/red-contract.md "Markdown"): returns an HTML string made only of
// p, br, strong, em, code, pre, ul, ol, li, blockquote, h1-h6, hr, a. `a` carries only `href`
// (http:, https:, mailto: or a #fragment) plus rel="noopener noreferrer". Raw HTML in the input
// is shown as text. Images are not rendered as <img>. No attribute other than a's href/rel.
export function renderMarkdown(_markdown: string): string {
  return "";
}

/** Text-safe embedding of JSON inside an HTML <script type="application/json"> element. */
export function jsonForScriptElement(_value: unknown): string {
  return "";
}

/** True for http:, https: URLs that may become a link target. */
export function isSafeLinkUrl(_url: string): boolean {
  return false;
}
