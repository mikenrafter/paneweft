// @vitest-environment jsdom
// MC15 untrusted content stays data: renderMarkdown, jsonForScriptElement, isSafeLinkUrl.
// Normative: docs/red-contract.md section 7; design section 5 ("Escape text; sanitize Markdown; forbid embedded scripts, raw
// event handlers, and arbitrary HTML renderers") and MC15. Output HTML is PARSED with jsdom's DOMParser and asserted on the
// tree (never on string shape), except two tiny cases. Markdown dialect assumed: CommonMark-style blocks and inlines
// (docs/contract-additions/nav.md); entity decoding is deliberately not pinned.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeLinkUrl, jsonForScriptElement, renderMarkdown } from "./markdown.ts";

const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a"]);

/** Parses an HTML fragment as the body of a full document, so head-only elements (script, style, meta) stay visible. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html");
}
function render(markdown: string): Document {
  return parse(renderMarkdown(markdown));
}
/** Every element below <body> or inside <head>, i.e. everything the output introduced. */
function allElements(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll("*")).filter((el) => !["html", "head", "body"].includes(el.tagName.toLowerCase()));
}
/** Violations of the output contract: disallowed tags and attributes. Empty array = clean. */
function violations(doc: Document): string[] {
  const found: string[] = [];
  for (const el of allElements(doc)) {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) found.push(`tag <${tag}>`);
    const names = Array.from(el.attributes).map((attribute) => attribute.name).sort();
    if (tag === "a") {
      if (names.join(",") !== "href,rel") found.push(`<a> attributes [${names.join(",")}]`);
      if (el.getAttribute("rel") !== "noopener noreferrer") found.push(`<a> rel=${el.getAttribute("rel")}`);
    } else if (names.length > 0) {
      found.push(`<${tag}> attributes [${names.join(",")}]`);
    }
  }
  return found;
}
const text = (doc: Document): string => doc.body.textContent ?? "";
/** JSON.parse that turns a parse failure into a value, so a broken embedding fails an assertion rather than throwing. */
const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source);
  } catch {
    return { unparseable: source.slice(0, 80) };
  }
};
const anchors = (doc: Document): HTMLAnchorElement[] => Array.from(doc.querySelectorAll("a"));

describe("the test walker itself (control)", () => {
  // why: every "no violations" assertion below is only meaningful if the walker really flags bad markup and really sees good
  //      markup. Positive control: it reports a script, an onclick, an <a target>, an <img>; and it sees every allowed tag in a
  //      clean sample (so an empty `*` selection cannot pass vacuously).
  // proves: CLAIM(MC15)
  it("[MC15] the walker flags unsafe markup and sees allowed markup", () => {
    expect(violations(parse('<p onclick="x()">a</p><script>1</script><img src="x"><a href="https://e.com" target="_blank" rel="noopener noreferrer">l</a>')).sort()).toStrictEqual(
      ["<a> attributes [href,rel,target]", "<img> attributes [src]", "<p> attributes [onclick]", "tag <img>", "tag <script>"].sort(),
    );
    const clean = parse('<h1>t</h1><p>a<br><strong>b</strong><em>c</em><code>d</code></p><pre><code>e</code></pre><ul><li>f</li></ul><ol><li>g</li></ol><blockquote><p>h</p></blockquote><hr><p><a href="#x" rel="noopener noreferrer">i</a></p>');
    expect(violations(clean)).toStrictEqual([]);
    expect(new Set(allElements(clean).map((el) => el.tagName.toLowerCase()))).toStrictEqual(new Set(["h1", "p", "br", "strong", "em", "code", "pre", "ul", "li", "ol", "blockquote", "hr", "a"]));
  });
});

describe("raw HTML in the input becomes text", () => {
  // why: design section 5 "forbid embedded scripts, raw event handlers, and arbitrary HTML renderers": each of these, written as
  //      Markdown, must appear as LITERAL TEXT (the characters are in textContent) and create no element at all. Rows are the
  //      classic vectors: script tag, img onerror, svg onload, iframe, raw anchor with onclick, style, inline handler on an allowed tag name.
  // proves: CLAIM(MC15)
  it.each([
    ["script tag", "<script>alert(1)</script>", "script"],
    ["img onerror", "<img src=x onerror=alert(1)>", "img"],
    ["svg onload", "<svg onload=alert(1)>", "svg"],
    ["iframe javascript url", '<iframe src="javascript:alert(1)"></iframe>', "iframe"],
    ["raw anchor with onclick", '<a onclick="alert(1)">click</a>', "a"],
    ["style element", "<style>body{display:none}</style>", "style"],
    ["handler on an otherwise allowed tag", '<p onmouseover="alert(1)">hover</p>', "p[onmouseover]"],
    ["details with ontoggle", "<details open ontoggle=alert(1)>", "details"],
  ] as const)("[MC15] %s is shown as escaped text", (_name, input, selector) => {
    const doc = render(input);
    expect(doc.querySelector(selector), `no <${selector}> element`).toBeNull();
    expect(text(doc)).toContain(input);
    expect(violations(doc)).toStrictEqual([]);
  });

  // why: the same payload inside inline code, a fenced block and link text stays text in each context (escape happens on every
  //      text path, not only in paragraphs).
  // proves: CLAIM(MC15)
  it.each([
    ["inline code", "`<img src=x onerror=alert(1)>`", "code"],
    ["fenced block", "```\n<script>alert(1)</script>\n```", "pre"],
    ["link text", "[<img src=x onerror=alert(1)>](https://example.com)", "a"],
    ["emphasis", "*<script>alert(1)</script>*", "em"],
    ["heading", "# <svg onload=alert(1)>", "h1"],
    ["blockquote", "> <iframe src=x></iframe>", "blockquote"],
    ["list item", "- <img src=x onerror=1>", "li"],
  ] as const)("[MC15] raw HTML inside %s is text", (_name, input, container) => {
    const doc = render(input);
    const host = doc.querySelector(container);
    expect(host, `${container} rendered`).not.toBeNull();
    expect(host?.textContent).toMatch(/<(img|script|svg|iframe)/);
    expect(doc.querySelector("script, img, svg, iframe")).toBeNull();
    expect(violations(doc)).toStrictEqual([]);
  });

  // why: HTML entities and bare angle brackets must not turn into markup after any decode step. `&lt;b&gt;` must not become a <b>
  //      element (whether the renderer then shows "<b>" or "&lt;b&gt;" is not pinned); `a < b && c > d` is plain text and must
  //      come back EXACTLY (no lost characters, no double escaping such as "&amp;lt;").
  // proves: CLAIM(MC15)
  it("[MC15] entities never become elements; plain text with < > & round-trips exactly", () => {
    const entity = render("&lt;b&gt;bold?&lt;/b&gt; and &#60;i&#62; and &amp;lt;");
    expect(entity.querySelector("b, i")).toBeNull();
    expect(text(entity)).toContain("bold?");
    expect(violations(entity)).toStrictEqual([]);
    const plain = render("a < b && c > d");
    expect(text(plain).trim()).toBe("a < b && c > d");
    expect(plain.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("links", () => {
  // why: the contract's allowlist for markdown links is http:, https:, mailto: and #fragment. Each becomes ONE <a> whose attributes
  //      are exactly href and rel="noopener noreferrer" (no target, style, class, title, on*), with the href equal to the source URL
  //      (decoded) and the link text as content. The query row has & in it, to pin attribute escaping.
  // proves: CLAIM(MC15)
  it.each([
    ["https with query", "[ok](https://example.com/p?q=1&r=2)", "https://example.com/p?q=1&r=2", "ok"],
    ["http", "[plain](http://example.com/a)", "http://example.com/a", "plain"],
    ["mailto", "[mail](mailto:dev@example.com)", "mailto:dev@example.com", "mail"],
    ["fragment", "[top](#section-1)", "#section-1", "top"],
    ["uppercase scheme", "[up](HTTPS://EXAMPLE.COM/X)", "HTTPS://EXAMPLE.COM/X", "up"],
  ] as const)("[MC15] a %s link becomes a hardened anchor", (_name, input, href, label) => {
    const doc = render(input);
    const found = anchors(doc);
    expect(found).toHaveLength(1);
    expect(found[0]?.getAttribute("href")?.toLowerCase(), "href equals the source URL (scheme/host case may be normalised)").toBe(href.toLowerCase());
    expect(found[0]?.textContent).toBe(label);
    expect(Array.from(found[0]?.attributes ?? []).map((a) => a.name).sort()).toStrictEqual(["href", "rel"]);
    expect(found[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(violations(doc)).toStrictEqual([]);
  });

  // why: a Markdown link title (`"t"`) and attribute-breaking characters in the URL must not add attributes: the anchor still has
  //      only href and rel, and the host stays example.com. (A renderer that interpolates the title or an unescaped quote
  //      into the tag lets `x" onmouseover="..."` through.)
  // proves: CLAIM(MC15)
  it.each([
    ["a link title", '[t](https://example.com/a "tooltip")'],
    ["a double quote in the URL", '[t](https://example.com/a"b=1)'],
    ["a quote and handler in the URL", '[t](https://example.com/"onmouseover="alert(1))'],
    ["an angle bracket in the URL", "[t](<https://example.com/a>b>)"],
  ] as const)("[MC15] %s adds no attribute to the anchor", (_name, input) => {
    const doc = render(input);
    expect(anchors(doc).length, "the link is still rendered").toBe(1);
    expect(new URL(anchors(doc)[0]!.getAttribute("href")!).hostname).toBe("example.com");
    expect(violations(doc)).toStrictEqual([]);
    expect(doc.querySelector("[onmouseover], [title]")).toBeNull();
  });

  // why: unsafe URL schemes render the LINK TEXT ONLY, no anchor and no href anywhere (contract: "renders the link text without a
  //      link"). Rows cover the schemes (javascript, vbscript, data, file), case mixing, entity-encoded and control-character
  //      obfuscation that a browser would normalise away, whitespace padding, protocol-relative and relative URLs, and a
  //      reference-style definition. Output is exactly the link text, so the URL is not smuggled in as an attribute.
  // proves: CLAIM(MC15)
  it.each([
    ["javascript:", "[click me](javascript:alert(1))"],
    ["mixed case", "[click me](JaVaScRiPt:alert(1))"],
    ["entity-encoded first letter", "[click me](&#106;avascript:alert(1))"],
    ["entity-encoded tab inside the scheme", "[click me](jav&#x09;ascript:alert(1))"],
    ["leading spaces", "[click me](   javascript:alert(1))"],
    ["leading control character", "[click me](\u0001javascript:alert(1))"],
    ["vbscript:", "[click me](vbscript:msgbox(1))"],
    ["data: html", "[click me](data:text/html,<script>alert(1)</script>)"],
    ["data: base64", "[click me](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["file:", "[click me](file:///etc/passwd)"],
    ["protocol-relative", "[click me](//evil.example/x)"],
    ["absolute path", "[click me](/etc/passwd)"],
    ["relative path", "[click me](../secret.txt)"],
    ["ftp:", "[click me](ftp://example.com/x)"],
    ["reference definition", "[click me][r]\n\n[r]: javascript:alert(1)"],
  ] as const)("[MC15] %s link renders only its text", (_name, input) => {
    const doc = render(input);
    expect(anchors(doc)).toHaveLength(0);
    expect(doc.querySelector("[href], [src], [action]")).toBeNull();
    expect(text(doc).trim()).toContain("click me");
    expect(violations(doc)).toStrictEqual([]);
  });

  // why: control for the table above: a safe URL in the SAME shapes (reference-style definition, padding spaces) does become a
  //      link, so the refusals are decided by the scheme and not by "links never work in this shape".
  // proves: CLAIM(MC15)
  it("[MC15] reference-style and space-padded safe URLs are links", () => {
    expect(anchors(render("[x][r]\n\n[r]: https://example.com/ref"))[0]?.getAttribute("href")).toBe("https://example.com/ref");
    expect(anchors(render("[x](   https://example.com/pad   )"))[0]?.getAttribute("href")).toBe("https://example.com/pad");
  });

  // why: an autolink of an unsafe scheme (`<javascript:...>`) and a bare dangerous URL must not become an anchor either.
  // proves: CLAIM(MC15)
  it("[MC15] an angle-bracket autolink with an unsafe scheme is not a link", () => {
    const doc = render("<javascript:alert(1)>");
    expect(text(doc), "the content is shown, not swallowed").toContain("javascript:alert(1)");
    expect(anchors(doc)).toHaveLength(0);
    expect(violations(doc)).toStrictEqual([]);
  });

  // why: design section 5 and the contract: images never become <img>. No element with src/srcset/data and nothing loads from
  //      a remote host. Rows: remote http, https, a data: URL, and an image with a javascript: URL; each leaves no URL-bearing
  //      attribute behind that carries a dangerous value.
  // proves: CLAIM(MC15)
  it.each([
    ["remote http image", "![alt text](http://evil.example/x.png)"],
    ["remote https image", "![alt text](https://evil.example/x.png)"],
    ["data image", "![alt text](data:image/png;base64,AAAA)"],
    ["javascript image", "![alt text](javascript:alert(1))"],
    ["image with title", '![alt text](https://evil.example/x.png "t")'],
  ] as const)("[MC15] %s yields no <img> and no src", (_name, input) => {
    const doc = render(input);
    expect(doc.querySelectorAll("img, picture, source, video, audio, embed, object")).toHaveLength(0);
    expect(doc.querySelectorAll("[src], [srcset], [data], [poster]")).toHaveLength(0);
    expect(text(doc), "the alt text survives as text").toContain("alt text");
    expect(violations(doc)).toStrictEqual([]);
    for (const el of allElements(doc)) for (const attribute of Array.from(el.attributes)) expect(attribute.value.toLowerCase()).not.toMatch(/javascript:|data:/);
  });
});

describe("allowed formatting", () => {
  // why: the Markdown subset that must render: each construct maps to its allowed element with the right text. A renderer that
  //      escapes everything (safe but useless) fails here; this is the positive side of the sanitiser.
  // proves: CLAIM(MC15)
  it.each([
    ["strong", "**bold**", "p > strong", "bold"],
    ["em", "*soft*", "p > em", "soft"],
    ["inline code", "`x < y`", "p > code", "x < y"],
    ["h1", "# Title", "h1", "Title"],
    ["h2", "## Title", "h2", "Title"],
    ["h3", "### Title", "h3", "Title"],
    ["h4", "#### Title", "h4", "Title"],
    ["h5", "##### Title", "h5", "Title"],
    ["h6", "###### Title", "h6", "Title"],
    ["blockquote", "> quoted", "blockquote", "quoted"],
  ] as const)("[MC15] %s renders as %s", (_name, input, selector, expectedText) => {
    const doc = render(input);
    const found = doc.querySelectorAll(selector);
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent?.trim()).toBe(expectedText);
    expect(violations(doc)).toStrictEqual([]);
  });

  // why: block constructs with several parts: unordered and ordered lists keep item order and count, a fenced block becomes
  //      <pre><code> with the code verbatim (including < and indentation), a thematic break is an <hr> between two paragraphs,
  //      and a trailing-double-space line break is a <br> inside one paragraph.
  // proves: CLAIM(MC15)
  it("[MC15] lists, fenced code, hr and br render with their structure", () => {
    const ul = render("- one\n- two\n- three");
    expect(Array.from(ul.querySelectorAll("ul > li")).map((li) => li.textContent?.trim())).toStrictEqual(["one", "two", "three"]);
    const ol = render("1. first\n2. second");
    expect(Array.from(ol.querySelectorAll("ol > li")).map((li) => li.textContent?.trim())).toStrictEqual(["first", "second"]);
    const code = render("```\nif (a < b) {\n  go();\n}\n```");
    expect(code.querySelector("pre code")?.textContent).toBe("if (a < b) {\n  go();\n}\n");
    const rule = render("above\n\n---\n\nbelow");
    expect(Array.from(rule.body.children).map((el) => el.tagName.toLowerCase())).toStrictEqual(["p", "hr", "p"]);
    const br = render("line one  \nline two");
    expect(br.querySelectorAll("p")).toHaveLength(1);
    expect(br.querySelectorAll("p > br")).toHaveLength(1);
    for (const doc of [ul, ol, code, rule, br]) expect(violations(doc)).toStrictEqual([]);
  });

  // why: whole-document walk with a positive control: a kitchen-sink document containing every allowed construct AND several attacks
  //      is parsed; EVERY element must be allowed and carry only permitted attributes, and the set of tags seen must contain each
  //      allowed tag we fed (so the walk is not over an empty tree).
  // proves: CLAIM(MC15)
  it("[MC15] a kitchen-sink document contains only allowed tags and attributes", () => {
    const doc = render(
      [
        "# Heading",
        "",
        "Paragraph with **strong**, *em*, `code`, a [link](https://example.com/x), [bad](javascript:alert(1)) and <script>alert(1)</script>.",
        "",
        "![img](http://evil.example/p.png)",
        "",
        "> quote with <img src=x onerror=alert(1)>",
        "",
        "- item one",
        "- item two",
        "",
        "1. first",
        "2. second",
        "",
        "```",
        "<b>code</b>",
        "```",
        "",
        "---",
        "",
        "hard  ",
        "break",
      ].join("\n"),
    );
    expect(violations(doc)).toStrictEqual([]);
    const seen = new Set(allElements(doc).map((el) => el.tagName.toLowerCase()));
    for (const tag of ["h1", "p", "strong", "em", "code", "a", "blockquote", "ul", "ol", "li", "pre", "hr", "br"]) expect(seen.has(tag), `<${tag}> present`).toBe(true);
    const hrefs = anchors(doc).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("https://example.com/x");
    expect(hrefs.some((href) => /^javascript:/i.test(href))).toBe(false);
  });
});

describe("edge inputs", () => {
  // why: empty input renders to the empty string (design: nothing invented), whitespace-only renders to nothing visible, and the
  //      control `x` proves the renderer is not simply returning "" for everything.
  // proves: CLAIM(MC15)
  it("[MC15] empty and whitespace-only input render to no content; non-empty input does", () => {
    expect(renderMarkdown("")).toBe("");
    const blank = render("  \n\n \t\n");
    expect(allElements(blank)).toHaveLength(0);
    expect(text(blank).trim()).toBe("");
    expect(text(render("x")).trim()).toBe("x");
  });

  // why: robustness: very long input and pathological nesting must not throw or hang (vitest's timeout is the hang detector), must produce
  //      a clean tree, and must not return "" for non-empty input. Text-bearing rows additionally require the text to survive in full
  //      (200k characters kept). Deeply nested rows only require non-empty clean output: how deep a renderer nests before it
  //      flattens is its own business, so "deep" is not demanded there.
  // proves: CLAIM(MC15)
  it.each([
    ["200k characters of text", "a".repeat(200_000), (doc: Document) => expect(text(doc).trim()).toHaveLength(200_000)],
    ["20k unclosed link brackets", "[".repeat(20_000) + "x", (doc: Document) => expect(text(doc)).toContain("x")],
    ["10k unmatched emphasis markers", "*a".repeat(10_000), (doc: Document) => expect(text(doc)).toContain("a")],
    ["10k open parentheses in a link destination", "[x](" + "(".repeat(10_000), (doc: Document) => expect(text(doc)).toContain("x")],
    ["3k nested blockquote markers", "> ".repeat(3_000) + "deep", () => undefined],
    ["2k nested list markers", "- ".repeat(2_000) + "deep", () => undefined],
  ] as const)("[MC15] %s does not throw and renders clean output", (_name, input, check) => {
    const html = renderMarkdown(input);
    expect(html, "non-empty input gives non-empty output").not.toBe("");
    const doc = parse(html);
    expect(violations(doc)).toStrictEqual([]);
    check(doc);
  });

  // why: Unicode must pass through unchanged (no mojibake, no stripped astral characters, bidi and zero-width characters are
  //      text and stay text), including a lone high surrogate that must not make the renderer throw.
  // proves: CLAIM(MC15)
  it("[MC15] unicode text is preserved and a lone surrogate does not throw", () => {
    const sample = "héllo wörld, 日本語, \u{1F642}, \u202eevil\u202c, a\u200bb, ñ";
    expect(text(render(sample)).trim()).toBe(sample);
    expect(() => renderMarkdown("lone \uD800 surrogate")).not.toThrow();
    expect(text(render("lone \uD800 surrogate"))).toContain("lone");
  });
});

describe("jsonForScriptElement", () => {
  const forbidden = /[<>&\u2028\u2029]/;
  const hostile = {
    close: "</script><script>alert(1)</script>",
    comment: "<!-- <script> -->",
    cdata: "a]]>b",
    amp: "Tom & Jerry &amp; &lt;",
    separators: "line\u2028sep\u2029par",
    surrogate: "lone \uD800 and \uDFFF here",
    unicode: "héllo 日本語 \u{1F642}",
    nested: [{ "</script>": ["<", ">", "&"] }, [[null, true, 1.5, -2]]],
    "<key>": "k",
  };

  // why: design section 5 and MC15 "closing script tokens in JSON": the embedding must contain no raw < > & U+2028 U+2029 anywhere
  //      (keys included) and JSON.parse must give the original value back, for strings with </script>, <!--, ]]>, &, separators,
  //      lone surrogates and non-ASCII text. The data must be intact, not merely escaped.
  // proves: CLAIM(MC15)
  it("[MC15] output has no raw < > & U+2028 U+2029 and parses back to the input", () => {
    const out = jsonForScriptElement(hostile);
    expect(out).not.toMatch(forbidden);
    expect(parseJson(out)).toStrictEqual(hostile);
  });

  // why: values that are not objects must survive too (top-level string, number, null, empty containers).
  // proves: CLAIM(MC15)
  it.each([["a string", "</script>"], ["a number", 42], ["null", null], ["an empty array", []], ["an empty object", {}], ["a boolean", false]] as const)(
    "[MC15] %s round-trips",
    (_name, value) => {
      const out = jsonForScriptElement(value);
      expect(out).not.toMatch(forbidden);
      expect(parseJson(out)).toStrictEqual(value);
    },
  );

  // why: the end-to-end claim: embed the output in a full HTML document inside <script type="application/json">, parse it with the HTML
  //      parser, and there is exactly ONE script element whose text parses back to the value. The payload includes both HTML
  //      "script data" traps: a closing tag and `<!--<script>` (which flips the tokenizer into the double-escaped state and would
  //      swallow the real closing tag). Negative control: the NAIVE JSON.stringify of the same value in the same document breaks
  //      the one-script invariant, proving the check can fail.
  // proves: CLAIM(MC15)
  it("[MC15] a document embedding the output has exactly one script element carrying the data", () => {
    const value = { a: "</script><img src=x onerror=alert(1)>", b: "<!--<script>", c: "<script><!--", d: "]]></script>" };
    const doc = (json: string) => new DOMParser().parseFromString(`<!doctype html><html><head><script type="application/json" id="data">${json}</script></head><body><p id="after">after</p></body></html>`, "text/html");
    const safe = doc(jsonForScriptElement(value));
    expect(safe.querySelectorAll("script")).toHaveLength(1);
    expect(parseJson(safe.getElementById("data")?.textContent ?? "")).toStrictEqual(value);
    expect(safe.querySelectorAll("img")).toHaveLength(0);
    expect(safe.getElementById("after")?.textContent).toBe("after");
    const naive = doc(JSON.stringify(value));
    expect(naive.querySelectorAll("script").length === 1 && naive.querySelectorAll("img").length === 0, "naive embedding is unsafe").toBe(false);
  });

  // why: generalisation of the two claims above over random JSON values built from hostile characters (seed 42): never a forbidden
  //      character in the output, always a faithful parse. Keys and strings draw from characters that matter to HTML or to line handling.
  // proves: CLAIM(MC15)
  it("[MC15] random hostile JSON values embed safely and round-trip (300 cases, seed 42)", () => {
    const nasty = fc.string({ unit: fc.constantFrom("<", ">", "&", "/", "!", "-", "]", "\u2028", "\u2029", "\uD800", "\uDFFF", "s", "c", "r", "\n", '"', "\\", "é"), maxLength: 12 });
    const value = fc.letrec((tie) => ({
      tree: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        nasty,
        fc.integer().map((n) => n + 0),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("tree"), { maxLength: 4 }),
        fc.array(fc.tuple(nasty.map((k) => `k${k}`), tie("tree")), { maxLength: 4 }).map((pairs) => Object.fromEntries(pairs)),
      ),
    })).tree;
    fc.assert(
      fc.property(value, (input) => {
        const out = jsonForScriptElement(input);
        expect(out).not.toMatch(forbidden);
        expect(parseJson(out)).toStrictEqual(input);
      }),
      { seed: 42, numRuns: 300 },
    );
  });
});

describe("isSafeLinkUrl", () => {
  // DECISIONS (docs/contract-additions/nav.md): isSafeLinkUrl accepts exactly http: and https: absolute URLs with a non-empty host,
  // case-insensitive scheme, and containing no whitespace or control characters anywhere (the caller must trim; browsers
  // strip tabs/newlines inside URLs, so tolerating them would hide `java\nscript:`). mailto: and #fragment are NOT accepted
  // here (the stub's doc: "True for http:, https: URLs"); renderMarkdown has its own wider allowlist for them.
  // why: the table of literal accepted URLs - scheme case, ports, userinfo, query, fragment, IPv6 host.
  // proves: CLAIM(MC15)
  it.each([
    "https://example.com",
    "http://example.com/a?b=1&c=2#frag",
    "HTTPS://EXAMPLE.COM/X",
    "HtTp://x.example",
    "http://localhost:8080/path",
    "https://user@example.com/",
    "http://[::1]:3000/x",
    "https://example.com/a%20b",
  ])("[MC15] accepts %s", (url) => {
    expect(isSafeLinkUrl(url)).toBe(true);
  });

  // why: the table of literal rejected inputs: dangerous schemes (case-mixed too), every whitespace/control obfuscation, other
  //      schemes, scheme-less and relative forms, empty and blank, a dangerous scheme that merely CONTAINS an https:// later,
  //      and the near misses (no host, no slashes, mailto, fragment).
  // proves: CLAIM(MC15)
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "javascript://https://example.com/%0aalert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "about:blank",
    "blob:https://example.com/uuid",
    "ftp://example.com/x",
    "ws://example.com/socket",
    "//evil.example/x",
    "/relative/path",
    "relative/path",
    "./x",
    "../x",
    "",
    "   ",
    " https://example.com",
    "https://example.com ",
    "https://exa mple.com",
    "https://example.com/\n",
    "https://",
    "http:",
    "https//example.com",
    "mailto:dev@example.com",
    "#fragment",
  ])("[MC15] rejects %j", (url) => {
    expect(isSafeLinkUrl("https://control.example/ok"), "paired positive control: the function is not constant false").toBe(true);
    expect(isSafeLinkUrl(url)).toBe(false);
  });
});
