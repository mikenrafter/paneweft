// Reduces a DOM subtree to the outline of its `data-pw` elements (docs/viewer-dom-contract.md).
// Goldens compare this outline, so they pin the contract elements and are blind to incidental markup.
// Deterministic: attributes sorted, whitespace collapsed, no ids/timestamps, no layout from the host.
export const OUTLINE_ATTRIBUTES = [
  "aria-current", "aria-expanded", "aria-haspopup", "aria-label", "aria-level", "aria-pressed", "aria-selected", "aria-sort",
  "d", "data-children-state", "data-code", "data-definition-id", "data-entity-id", "data-group", "data-highlighted", "data-id",
  "data-kind", "data-layout", "data-layout-version", "data-line", "data-lines", "data-matched", "data-passed", "data-path",
  "data-pane-index", "data-pinned", "data-presence", "data-provenance", "data-run-id", "data-snapshot-id", "data-source",
  "data-status", "data-total", "data-view-id", "data-x", "data-y", "href", "role", "tabindex",
] as const;

function ownText(element: Element): string {
  let text = "";
  const visit = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) text += child.textContent ?? "";
      else if (child.nodeType === 1) {
        if (!(child as Element).hasAttribute("data-pw")) visit(child);
      }
    }
  };
  visit(element);
  return text.replace(/\s+/g, " ").trim();
}

export function outline(root: Element): string {
  const lines: string[] = [];
  const visit = (element: Element, depth: number): void => {
    let next = depth;
    const name = element.getAttribute("data-pw");
    if (name !== null) {
      const attributes = OUTLINE_ATTRIBUTES.filter((attribute) => element.hasAttribute(attribute))
        .map((attribute) => ` ${attribute}=${JSON.stringify(element.getAttribute(attribute))}`)
        .join("");
      const text = ownText(element);
      lines.push(`${"  ".repeat(depth)}${name}${attributes}${text === "" ? "" : ` ${JSON.stringify(text)}`}`);
      next = depth + 1;
    }
    for (const child of Array.from(element.children)) visit(child, next);
  };
  visit(root, 0);
  return lines.join("\n") + "\n";
}
