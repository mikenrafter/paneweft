// Sanitised Markdown for notebook prose (design section 5: "sanitize Markdown; forbid embedded
// scripts, raw event handlers, and arbitrary HTML renderers").
// Contract (docs/red-contract.md "Markdown"): returns an HTML string made only of
// p, br, strong, em, code, pre, ul, ol, li, blockquote, h1-h6, hr, a. `a` carries only `href`
// (http:, https:, mailto: or a #fragment) plus rel="noopener noreferrer". Raw HTML in the input
// is shown as text. Images are not rendered as <img>. No attribute other than a's href/rel.
//
// CLAIM(markdown-closed-output): every character of the input reaches the output only through `escapeHtml`, and every tag is
//   written by this file's own templates, so no input can introduce a tag, attribute or script [markdown.test.ts, MC15].
// CLAIM(markdown-bounded): block nesting is capped (MAX_BLOCK_DEPTH) and every inline scan is linear in the text length
//   (bracket pairs are matched once per text), so hostile nesting and unmatched markers cannot exhaust the stack or the clock
//   [markdown.test.ts "does not throw" cases].
// Dialect: a CommonMark subset (ATX headings, fenced code, `-`/`*`/`+` and `1.` lists, `>` quotes, `---`, code spans, `*`/`_`
// emphasis, inline and reference links, autolinks, two-space hard breaks). Entities are NOT decoded: `&lt;` is shown as typed.

const MAX_BLOCK_DEPTH = 8;
const MAX_INLINE_DEPTH = 8;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** True for http: and https: URLs that may become a link target. */
export function isSafeLinkUrl(url: string): boolean {
  // scheme (any case), '//', then a host that does not start with a delimiter; no whitespace or control character anywhere, no trimming
  return /^https?:\/\/[^\s\u0000-\u001f\u007f\u0085\u00a0\u2028\u2029\/?#][^\s\u0000-\u001f\u007f\u0085\u2028\u2029]*$/i.test(url);
}

/** What a Markdown link may point at: the strict web allowlist above plus mailto: and in-page #fragments. */
function isLinkableDestination(destination: string): boolean {
  return isSafeLinkUrl(destination) || /^mailto:[^\s\u0000-\u001f\u007f<>]+$/i.test(destination) || /^#[^\s\u0000-\u001f\u007f]*$/.test(destination);
}

/** Percent-encodes what could break out of an attribute value or a URL; existing %XX escapes are kept. */
function encodeHref(destination: string): string {
  return destination
    .replace(/[\s"<>\\`^{|}\u0000-\u001f\u007f]/g, (character) => encodeURIComponent(character).replace(/'/g, "%27") || "%20")
    .replace(/&/g, "&amp;");
}

interface Context { references: Map<string, string> }

// ---- inline ----------------------------------------------------------------------------------------------------

/** For every '[' the index of its matching ']' (nesting counted, backslash escapes skipped), computed once per text in O(n). */
function matchBrackets(text: string): Map<number, number> {
  const matches = new Map<number, number>();
  const open: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") { index++; continue; }
    if (character === "[") open.push(index);
    else if (character === "]" && open.length > 0) matches.set(open.pop() as number, index);
  }
  return matches;
}

function findClosingParenthesis(text: string, from: number): number {
  let depth = 1;
  for (let index = from; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") { index++; continue; }
    if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index;
  }
  return -1;
}

/** "dest" or "dest 'title'" -> dest. Surrounding spaces and <> are dropped; the title is discarded. */
function destinationOf(raw: string): string {
  let destination = raw.trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(destination);
  if (titled !== null) destination = titled[1] as string;
  if (destination.length >= 2 && destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1);
  return destination;
}

function renderInline(text: string, context: Context, depth: number, insideLink: boolean): string {
  const brackets = text.includes("[") ? matchBrackets(text) : new Map<number, number>();
  let out = "";
  let index = 0;
  const specials = /[\\`!\[<*_&\n]/g;
  while (index < text.length) {
    specials.lastIndex = index;
    const found = specials.exec(text);
    const next = found === null ? text.length : found.index;
    if (next > index) out += escapeHtml(text.slice(index, next));
    if (found === null) break;
    index = next;
    const character = text[index] as string;

    if (character === "\n") {
      const trailing = /[ ]+$/.exec(out);
      // two or more spaces before a newline are a hard break; the spaces were already emitted as text, so trim them
      if (trailing !== null && trailing[0].length >= 2) out = out.slice(0, out.length - trailing[0].length) + "<br>";
      else out += "\n";
      index++;
      continue;
    }
    if (character === "\\" && index + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[index + 1] as string)) {
      out += escapeHtml(text[index + 1] as string);
      index += 2;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (text[index + run] === "`") run++;
      const marker = "`".repeat(run);
      let close = text.indexOf(marker, index + run);
      while (close >= 0 && text[close + run] === "`") close = text.indexOf(marker, close + run + 1);
      if (close >= 0) {
        let content = text.slice(index + run, close).replace(/\n/g, " ");
        if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") content = content.slice(1, -1);
        out += `<code>${escapeHtml(content)}</code>`;
        index = close + run;
      } else {
        out += escapeHtml(marker);
        index += run;
      }
      continue;
    }
    const isImage = character === "!" && text[index + 1] === "[";
    if (character === "[" || isImage) {
      const open = isImage ? index + 1 : index;
      const close = brackets.get(open);
      if (close !== undefined) {
        const label = text.slice(open + 1, close);
        let destination: string | null = null;
        let end = close + 1;
        if (text[close + 1] === "(") {
          const closeParen = findClosingParenthesis(text, close + 2);
          if (closeParen >= 0) { destination = destinationOf(text.slice(close + 2, closeParen)); end = closeParen + 1; }
        } else if (text[close + 1] === "[") {
          const closeRef = text.indexOf("]", close + 2);
          if (closeRef >= 0) {
            const key = (text.slice(close + 2, closeRef) || label).toLowerCase();
            if (context.references.has(key)) { destination = context.references.get(key) as string; end = closeRef + 1; }
          }
        } else if (context.references.has(label.toLowerCase())) {
          destination = context.references.get(label.toLowerCase()) as string;
        }
        if (destination !== null) {
          if (isImage) {
            out += escapeHtml(label); // an image is never fetched or embedded; its alt text stays visible
          } else {
            const inner = depth >= MAX_INLINE_DEPTH ? escapeHtml(label) : renderInline(label, context, depth + 1, true);
            out += !insideLink && isLinkableDestination(destination) ? `<a href="${encodeHref(destination)}" rel="noopener noreferrer">${inner}</a>` : inner;
          }
          index = end;
          continue;
        }
      }
      out += escapeHtml(character);
      index++;
      continue;
    }
    if (character === "<") {
      const autolink = /^<((?:https?:|mailto:)[^\s<>]*)>/i.exec(text.slice(index, index + 2050));
      if (autolink !== null && isLinkableDestination(autolink[1] as string) && !insideLink) {
        out += `<a href="${encodeHref(autolink[1] as string)}" rel="noopener noreferrer">${escapeHtml(autolink[1] as string)}</a>`;
        index += (autolink[0] as string).length;
      } else {
        out += "&lt;";
        index++;
      }
      continue;
    }
    if (character === "*" || character === "_") {
      let run = 1;
      while (text[index + run] === character) run++;
      const width = run >= 2 ? 2 : 1;
      const before = index === 0 ? " " : (text[index - 1] as string);
      const after = text[index + width] ?? " ";
      const opens = !/\s/.test(after) && (character === "*" || !/[0-9A-Za-z]/.test(before)) && depth < MAX_INLINE_DEPTH;
      let closeAt = -1;
      if (opens) {
        const marker = character.repeat(width);
        for (let from = index + width; ;) {
          const candidate = text.indexOf(marker, from);
          if (candidate < 0) break;
          const prior = text[candidate - 1] as string;
          const following = text[candidate + width] ?? " ";
          const closes = candidate > index + width && !/\s/.test(prior) && prior !== character && following !== character && (character === "*" || !/[0-9A-Za-z]/.test(following));
          if (closes) { closeAt = candidate; break; }
          from = candidate + 1;
        }
      }
      if (closeAt >= 0) {
        const tag = width === 2 ? "strong" : "em";
        out += `<${tag}>${renderInline(text.slice(index + width, closeAt), context, depth + 1, insideLink)}</${tag}>`;
        index = closeAt + width;
      } else {
        out += escapeHtml(character.repeat(width));
        index += width;
      }
      continue;
    }
    // '&' and '!' that start nothing
    out += escapeHtml(character);
    index++;
  }
  return out;
}

// ---- blocks ------------------------------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const REFERENCE = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

function startsBlock(line: string): boolean {
  if (FENCE.test(line) || QUOTE.test(line) || RULE.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return true;
  const item = LIST_ITEM.exec(line);
  return item !== null && (item[3] ?? "") !== ""; // a list may interrupt a paragraph (simplification of CommonMark's rule)
}

function renderBlocks(lines: string[], context: Context, depth: number): string {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === "") { index++; continue; }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] as string;
      const body: string[] = [];
      index++;
      while (index < lines.length) {
        const candidate = lines[index] as string;
        const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
        if (closing.test(candidate)) { index++; break; }
        body.push(candidate);
        index++;
      }
      out.push(`<pre><code>${escapeHtml(body.length > 0 ? body.join("\n") + "\n" : "")}</code></pre>`);
      continue;
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading !== null && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      const level = (heading[1] as string).length;
      out.push(`<h${level}>${renderInline((heading[2] ?? "").trim(), context, 0, false)}</h${level}>`);
      index++;
      continue;
    }

    if (RULE.test(line)) { out.push("<hr>"); index++; continue; }

    if (QUOTE.test(line) && depth < MAX_BLOCK_DEPTH) {
      const inner: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] as string)) {
        inner.push((lines[index] as string).replace(/^ {0,3}> ?/, ""));
        index++;
      }
      out.push(`<blockquote>${renderBlocks(inner, context, depth + 1)}</blockquote>`);
      continue;
    }

    const first = LIST_ITEM.exec(line);
    if (first !== null && depth < MAX_BLOCK_DEPTH) {
      const ordered = /^\d/.test(first[2] as string);
      const bullet = ordered ? "" : (first[2] as string);
      const items: string[][] = [];
      while (index < lines.length) {
        const candidate = LIST_ITEM.exec(lines[index] as string);
        if (candidate === null || /^\d/.test(candidate[2] as string) !== ordered || (!ordered && candidate[2] !== bullet)) break;
        const content: string[] = [candidate[3] ?? ""];
        const indent = (candidate[1] as string).length + (candidate[2] as string).length + 1;
        index++;
        while (index < lines.length) {
          const following = lines[index] as string;
          if (following.trim() === "") {
            // a blank line continues the item only when the next non-blank line is indented under it
            const nextLine = lines.slice(index + 1).find((entry) => entry.trim() !== "");
            if (nextLine !== undefined && /^ {2,}\S/.test(nextLine)) { content.push(""); index++; continue; }
            break;
          }
          if (/^ {2,}\S/.test(following)) { content.push(following.slice(Math.min(indent, following.length - following.trimStart().length))); index++; continue; }
          if (LIST_ITEM.test(following) || startsBlock(following)) break;
          content.push(following);
          index++;
        }
        items.push(content);
        while (index < lines.length && (lines[index] as string).trim() === "" && LIST_ITEM.test(lines.slice(index + 1).find((entry) => entry.trim() !== "") ?? "")) index++;
      }
      const tag = ordered ? "ol" : "ul";
      const rendered = items.map((content) => {
        const html = renderBlocks(content, context, depth + 1);
        const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
        return `<li>${single !== null && !single[1]?.includes("</p>") ? single[1] : html}</li>`;
      });
      out.push(`<${tag}>${rendered.join("")}</${tag}>`);
      continue;
    }

    if (REFERENCE.test(line)) {
      const match = REFERENCE.exec(line) as RegExpExecArray;
      const key = (match[1] as string).toLowerCase();
      if (!context.references.has(key)) context.references.set(key, destinationOf(match[2] as string));
      index++;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] as string).trim() !== "" && (paragraph.length === 0 || !startsBlock(lines[index] as string))) {
      paragraph.push((lines[index] as string).replace(/^[ \t]+/, ""));
      index++;
    }
    const text = paragraph.join("\n").replace(/[ \t]+$/, "");
    out.push(`<p>${renderInline(text, context, 0, false)}</p>`);
  }
  return out.join("");
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const context: Context = { references: new Map() };
  // reference definitions may follow their use: collect them in a first pass, outside fenced code
  let fenced: string | null = null;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] as string;
      if (fenced === null) fenced = marker[0] as string;
      else if (marker[0] === fenced) fenced = null;
      continue;
    }
    if (fenced !== null) continue;
    const match = REFERENCE.exec(line);
    if (match !== null) {
      const key = (match[1] as string).toLowerCase();
      if (!context.references.has(key)) context.references.set(key, destinationOf(match[2] as string));
    }
  }
  return renderBlocks(lines, context, 0);
}

/** Text-safe embedding of JSON inside an HTML <script type="application/json"> element. */
export function jsonForScriptElement(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
