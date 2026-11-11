// Small DOM construction helpers. Every value reaches the page through setAttribute / textContent, never through markup.
const SVG_NS = "http://www.w3.org/2000/svg";

export type Attrs = Record<string, string | number | null | undefined>;
export type Child = Node | string | null | undefined | false;

function apply(element: Element, attrs: Attrs, children: Child[]): void {
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? element.ownerDocument.createTextNode(child) : child);
  }
}

/** An HTML element. `pw` becomes the data-pw attribute. */
export function h(doc: Document, tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const element = doc.createElement(tag);
  apply(element, attrs, children);
  return element;
}

/** An SVG element. */
export function svg(doc: Document, tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement {
  const element = doc.createElementNS(SVG_NS, tag);
  apply(element, attrs, children);
  return element;
}

/** Appends `children` (skipping empty ones) and returns the element. */
export function append<T extends Element>(element: T, ...children: Child[]): T {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? element.ownerDocument.createTextNode(child) : child);
  }
  return element;
}
