// Source anchors resolve only inside registered repository roots (design 5, MC6, MC15; red-contract 2).
// Everything here uses real temp directories and real symlinks; expected hashes are literals, each with
// the file content they were computed from (sha256sum over those exact bytes on this host).
//
// Layout of every test world (base = fresh temp dir):
//   base/secret.txt            "TOP-SECRET-7f3a91\n"   OUTSIDE the root: must never appear in any result
//   base/outside-dir/data.txt  "TOP-SECRET-7f3a91\n"
//   base/repo-evil/f           "EVIL-CONTENT\n"        a sibling whose name starts with the root's name
//   base/repo/                 the registered root
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSourceAnchor, type ResolvedAnchor } from "./anchors.ts";
import type { Result } from "./errors.ts";
import type { RepositoryRegistration } from "./session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { must } from "../../test/helpers/must.ts";

const SECRET = "TOP-SECRET-7f3a91";
const EVIL = "EVIL-CONTENT";

// content -> sha256 (computed with python hashlib over the exact bytes; see the literals below)
const SIX = "line one\nline two\nline three\nline four\nline five\nline six\n";
const SIX_SHA = "ebfbebf1b5e92225ffaad989f6ef26d2fd05dd679819b201fe4d0a2cc863038e";
const CRLF = "alpha\r\nbeta\r\ngamma\r\n";
const CRLF_SHA = "c8dba68945249de9b4faed72b89e041e3df77ffff885122599e6c2f7c65a68b2";
const NO_NEWLINE = "x1\nx2\nx3"; // no trailing newline: 3 lines
const NO_NEWLINE_SHA = "cefc896f28ece57ec4aa022e1fc9bbe7c5409f0bfab0dd3efcf3a7251a7c9f4e";
const ONE_LINE = "only\n";
const ONE_LINE_SHA = "321b4285d2fec34a6dc5b6fdb1ab9ee46b1a3129c83e52a00a713a38bac0fe00";
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha256("")
const UNICODE = "h\u00e9llo \u2713\nsecond\n"; // "héllo ✓\nsecond\n"
const UNICODE_SHA = "6d27a091859dd34a16c5c26ab85d84115187e0da8b1c3e15332afaab2274f1ae";
const PCT_FILE = "literal-percent-file\n";
const PCT_FILE_SHA = "46c18bb198dac2f31af208481ea57566b7b089697a49ca8ca594d8a8206424ab";
const INSIDE_LITERAL = "inside-literal\n";
const INSIDE_LITERAL_SHA = "62cfec66386e06cffeaaec6a47447cc2615e507711a8bbe6192bed8163cadf70";

const tmp = useTempDirs();

function world() {
  const base = tmp("anchors");
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(base, "outside-dir"));
  mkdirSync(join(base, "repo-evil"));
  writeFileSync(join(base, "secret.txt"), `${SECRET}\n`);
  writeFileSync(join(base, "outside-dir", "data.txt"), `${SECRET}\n`);
  writeFileSync(join(base, "repo-evil", "f"), `${EVIL}\n`);
  writeFileSync(join(root, "src", "six.txt"), SIX);
  writeFileSync(join(root, "crlf.txt"), CRLF);
  writeFileSync(join(root, "nonl.txt"), NO_NEWLINE);
  writeFileSync(join(root, "one.txt"), ONE_LINE);
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(root, "unicode.txt"), UNICODE);
  const repos: RepositoryRegistration[] = [{ id: "r", root }];
  return { base, root, repos };
}

const at = (path: string, first: number, last = first) => ({ repository: "r", path, lines: [first, last] as [number, number] });

/** Asserts a rejection with `code`, no error data, and that no outside content leaked into the error. */
function expectRejected<T>(result: Result<T>, code: string, label = "anchor"): void {
  expect(result.ok, label).toBe(false);
  const json = JSON.stringify(result);
  expect(json, label).not.toContain(SECRET);
  expect(json, label).not.toContain(EVIL);
  if (result.ok) return; // narrowing only: the assertion above already failed the test
  expect(result.error.code, label).toBe(code);
  expect(result.error.details, label).toBeUndefined();
}

describe("resolveSourceAnchor: reads exactly the requested numbered lines", () => {
  // why: an anchor that returns the wrong lines, drops file numbering, or hashes the excerpt instead of
  //   the file would open the wrong evidence. Lines [4,5] of a 6-line file keep numbers 4 and 5.
  // proves: CLAIM(MC6)
  it("[MC6] returns lines 4-5 of a 6-line file with file numbering and the whole-file sha256", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("src/six.txt", 4, 5)));
    expect(resolved).toEqual<ResolvedAnchor>({
      repository: "r",
      relativePath: "src/six.txt",
      lines: [4, 5],
      numberedLines: [{ n: 4, text: "line four" }, { n: 5, text: "line five" }],
      fileSha256: SIX_SHA,
    });
  });

  // why: the boundaries of a range are the classic off-by-one; first and last lines must both be included.
  // proves: CLAIM(MC6)
  it("[MC6] a range covering the whole file returns all six lines, first and last included", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("src/six.txt", 1, 6)));
    expect(resolved.numberedLines).toEqual([
      { n: 1, text: "line one" }, { n: 2, text: "line two" }, { n: 3, text: "line three" },
      { n: 4, text: "line four" }, { n: 5, text: "line five" }, { n: 6, text: "line six" },
    ]);
    expect(resolved.fileSha256).toBe(SIX_SHA);
  });

  // why: a single-line anchor is [n,n]; it must return exactly one line, not zero or two.
  // proves: CLAIM(MC6)
  it("[MC6] a single-line anchor returns exactly that line", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("src/six.txt", 3)));
    expect(resolved.lines).toEqual([3, 3]);
    expect(resolved.numberedLines).toEqual([{ n: 3, text: "line three" }]);
  });

  // why: CRLF files are common; the line terminator is not part of the line text, and the hash is over
  //   the raw bytes (the CR bytes are in the digest). Red-contract addition store.md#1.
  // proves: CLAIM(MC6)
  it("[MC6] CRLF file: line text excludes the terminator, fileSha256 covers the raw CRLF bytes", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("crlf.txt", 2, 3)));
    expect(resolved.numberedLines).toEqual([{ n: 2, text: "beta" }, { n: 3, text: "gamma" }]);
    expect(resolved.fileSha256).toBe(CRLF_SHA);
  });

  // why: a file without a trailing newline still has its last line; it must be returnable.
  // proves: CLAIM(MC6)
  it("[MC6] file without trailing newline: the last line is addressable", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("nonl.txt", 3)));
    expect(resolved.numberedLines).toEqual([{ n: 3, text: "x3" }]);
    expect(resolved.fileSha256).toBe(NO_NEWLINE_SHA);
  });

  // why: a one-line file whose only line ends in "\n" has exactly one line; the empty "line" after the
  //   final newline is not a line (see the out-of-range cases below for the other side).
  // proves: CLAIM(MC6)
  it("[MC6] one-line file with trailing newline resolves line 1", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("one.txt", 1)));
    expect(resolved.numberedLines).toEqual([{ n: 1, text: "only" }]);
    expect(resolved.fileSha256).toBe(ONE_LINE_SHA);
  });

  // why: text is UTF-8; multibyte characters must survive and the digest is over bytes, not characters.
  // proves: CLAIM(MC6)
  it("[MC6] UTF-8 multibyte text is returned intact and hashed as bytes", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("unicode.txt", 1)));
    expect(resolved.numberedLines).toEqual([{ n: 1, text: "h\u00e9llo \u2713" }]);
    expect(resolved.fileSha256).toBe(UNICODE_SHA);
  });

  // why: `./src/x` is an ordinary spelling; relativePath is the normalised form (store.md#1).
  // proves: CLAIM(MC6)
  it("[MC6] a leading ./ is accepted and normalised in relativePath", async () => {
    const { repos } = world();
    const resolved = must(await resolveSourceAnchor(repos, at("./src/six.txt", 1)));
    expect(resolved.relativePath).toBe("src/six.txt");
    expect(resolved.fileSha256).toBe(SIX_SHA);
  });

  // why: with several registered repositories an anchor resolves in ITS repository only; the same
  //   relative path in another repository must not be read.
  // proves: CLAIM(MC6)
  it("[MC6] resolves inside the repository named by the anchor when several are registered", async () => {
    const { base, repos } = world();
    const other = join(base, "other");
    mkdirSync(other);
    writeFileSync(join(other, "same.txt"), "from-other\n");
    writeFileSync(join(repos[0]!.root, "same.txt"), "from-repo\n");
    const both: RepositoryRegistration[] = [...repos, { id: "o", root: other }];
    const fromOther = must(await resolveSourceAnchor(both, { repository: "o", path: "same.txt", lines: [1, 1] }));
    const fromRepo = must(await resolveSourceAnchor(both, at("same.txt", 1)));
    expect(fromOther.numberedLines).toEqual([{ n: 1, text: "from-other" }]);
    expect(fromRepo.numberedLines).toEqual([{ n: 1, text: "from-repo" }]);
  });
});

describe("resolveSourceAnchor: ranges and missing things", () => {
  // why: a range past EOF must be refused, never clipped, so the caller cannot believe it read lines
  //   that do not exist. A file ending in "\n" has no line after the last one.
  // proves: CLAIM(MC6)
  it("[MC6] LINES_OUT_OF_RANGE: past EOF, past the final newline, in a file without final newline, in an empty file", async () => {
    const { repos } = world();
    const cases = [
      ["last line beyond EOF", "src/six.txt", 5, 7],
      ["first line beyond EOF", "src/six.txt", 7, 7],
      ["the phantom line after a final newline", "one.txt", 2, 2],
      ["line 4 of a 3-line file without final newline", "nonl.txt", 4, 4],
      ["any line of an empty file", "empty.txt", 1, 1],
    ] as const;
    for (const [name, path, first, last] of cases) expectRejected(await resolveSourceAnchor(repos, at(path, first, last)), "LINES_OUT_OF_RANGE", name);
  });

  // why: a missing file is NOT_FOUND, not a crash and not an empty excerpt.
  // proves: CLAIM(MC6)
  it("[MC6] NOT_FOUND for a file that does not exist inside the root", async () => {
    const { repos } = world();
    expectRejected(await resolveSourceAnchor(repos, at("src/missing.txt", 1)), "NOT_FOUND");
  });

  // why: the anchor names a repository id the owner never registered; no root is guessed.
  // proves: CLAIM(MC6)
  it("[MC6] REPOSITORY_NOT_REGISTERED for an unknown repository id", async () => {
    const { repos } = world();
    expectRejected(await resolveSourceAnchor(repos, { repository: "nope", path: "src/six.txt", lines: [1, 1] }), "REPOSITORY_NOT_REGISTERED");
    expectRejected(await resolveSourceAnchor([], at("src/six.txt", 1)), "REPOSITORY_NOT_REGISTERED");
  });
});

describe("resolveSourceAnchor: lexical traversal is refused (INVALID_PATH)", () => {
  // why: traversal, absolute paths, backslash spellings, NUL bytes and the empty path are refused BEFORE
  //   touching the file system; the secret outside the root must never be read or echoed.
  //   Decision store.md#2: every `..` segment is INVALID_PATH; PATH_OUTSIDE_ROOT is for resolved escapes.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] INVALID_PATH: parent traversal in every spelling, including a sibling-prefix target", async () => {
    const { repos } = world();
    const spellings = ["../secret.txt", "src/../../secret.txt", "./../secret.txt", "../repo-evil/f", "..\\secret.txt", "src\\..\\..\\secret.txt"];
    for (const path of spellings) expectRejected(await resolveSourceAnchor(repos, at(path, 1)), "INVALID_PATH", path);
  });

  // why: the non-traversal lexical faults: absolute paths, backslash spellings (a `\\` is never a separator
  //   we accept), drive letters, NUL bytes (C-string truncation) and the empty path.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] INVALID_PATH: absolute paths, backslash and drive-letter forms, NUL bytes, the empty path", async () => {
    const { repos } = world();
    const spellings = ["/etc/passwd", "\\etc\\passwd", "C:\\Windows\\win.ini", "src/six.txt\u0000.png", "src/\u0000", ""];
    for (const path of spellings) expectRejected(await resolveSourceAnchor(repos, at(path, 1)), "INVALID_PATH", JSON.stringify(path));
  });

  // why: an absolute path that happens to point INSIDE the root is still refused: anchors are
  //   repository-relative, and accepting absolutes would make the root check the only defence.
  // proves: CLAIM(MC6)
  it("[MC6] INVALID_PATH: an absolute path that names a file inside the root", async () => {
    const { root, repos } = world();
    expectRejected(await resolveSourceAnchor(repos, at(join(root, "src", "six.txt"), 1)), "INVALID_PATH");
  });
});

describe("resolveSourceAnchor: percent-encoding is literal", () => {
  // why: URL-style decoding must never happen: `%2e%2e` is an ordinary file name. A decoder would turn
  //   it into `..` (traversal) or fail to find the real file. Positive control: the literal file reads.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] a file literally named %2e%2e is readable", async () => {
    const { root, repos } = world();
    writeFileSync(join(root, "%2e%2e"), PCT_FILE);
    const resolved = must(await resolveSourceAnchor(repos, at("%2e%2e", 1)));
    expect(resolved.numberedLines).toEqual([{ n: 1, text: "literal-percent-file" }]);
    expect(resolved.fileSha256).toBe(PCT_FILE_SHA);
  });

  // why: `%2e%2e/secret` must resolve to the literal directory `%2e%2e` INSIDE the root, not to
  //   `../secret` (which holds the outside secret).
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] %2e%2e/secret reads the literal directory inside the root, not the parent", async () => {
    const { base, root, repos } = world();
    mkdirSync(join(root, "%2e%2e"));
    writeFileSync(join(root, "%2e%2e", "secret"), INSIDE_LITERAL);
    writeFileSync(join(base, "secret"), `${SECRET}\n`); // what a decoded `../secret` would read
    const resolved = must(await resolveSourceAnchor(repos, at("%2e%2e/secret", 1)));
    expect(resolved.numberedLines).toEqual([{ n: 1, text: "inside-literal" }]);
    expect(resolved.fileSha256).toBe(INSIDE_LITERAL_SHA);
    expect(JSON.stringify(resolved)).not.toContain(SECRET);
  });

  // why: an encoded traversal that names no literal file is simply NOT_FOUND; it does not traverse.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] %2e%2e%2fsecret.txt is a (missing) literal name: NOT_FOUND, secret not read", async () => {
    const { repos } = world();
    expectRejected(await resolveSourceAnchor(repos, at("%2e%2e%2fsecret.txt", 1)), "NOT_FOUND");
  });
});

describe("resolveSourceAnchor: symlinks", () => {
  // why: a symlink inside the root pointing at an inside file is legitimate (positive control for every
  //   rejection below: the rejections come from the target, not from "a symlink exists").
  // proves: CLAIM(MC6)
  it("[MC6] a symlink inside the root to an inside file is allowed (positive control)", async () => {
    const { root, repos } = world();
    symlinkSync("src/six.txt", join(root, "alias.txt"));
    const resolved = must(await resolveSourceAnchor(repos, at("alias.txt", 4, 4)));
    expect(resolved.numberedLines).toEqual([{ n: 4, text: "line four" }]);
    expect(resolved.fileSha256).toBe(SIX_SHA);
  });

  // why: chains are followed to the end; a chain that stays inside is fine.
  // proves: CLAIM(MC6)
  it("[MC6] a symlink chain that stays inside the root is allowed", async () => {
    const { root, repos } = world();
    symlinkSync("src/six.txt", join(root, "i2"));
    symlinkSync("i2", join(root, "i1"));
    const resolved = must(await resolveSourceAnchor(repos, at("i1", 1)));
    expect(resolved.numberedLines).toEqual([{ n: 1, text: "line one" }]);
  });

  // why: the root may itself be reached through a symlink (macOS /tmp, bind mounts); the canonicalised
  //   root is the boundary, so files under it must still resolve.
  // proves: CLAIM(MC6)
  it("[MC6] a registered root that is itself a symlink to the real directory works", async () => {
    const { base, root } = world();
    const link = join(base, "root-link");
    symlinkSync(root, link);
    const resolved = must(await resolveSourceAnchor([{ id: "r", root: link }], at("src/six.txt", 2)));
    expect(resolved.numberedLines).toEqual([{ n: 2, text: "line two" }]);
    expect(resolved.fileSha256).toBe(SIX_SHA);
  });

  // why: the headline traversal bug: a file symlink whose target is outside the root. Lexically the
  //   path is innocent; only realpath reveals the escape.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] PATH_OUTSIDE_ROOT: relative file symlink to an outside file", async () => {
    const { root, repos } = world();
    symlinkSync("../secret.txt", join(root, "leak.txt"));
    expectRejected(await resolveSourceAnchor(repos, at("leak.txt", 1)), "PATH_OUTSIDE_ROOT");
  });

  // why: same escape with an absolute link target.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] PATH_OUTSIDE_ROOT: absolute file symlink to an outside file", async () => {
    const { base, root, repos } = world();
    symlinkSync(join(base, "secret.txt"), join(root, "abs-leak.txt"));
    expectRejected(await resolveSourceAnchor(repos, at("abs-leak.txt", 1)), "PATH_OUTSIDE_ROOT");
  });

  // why: escape through an intermediate DIRECTORY symlink; checking only the final component misses it.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] PATH_OUTSIDE_ROOT: a directory symlink leaving the root", async () => {
    const { base, root, repos } = world();
    symlinkSync(join(base, "outside-dir"), join(root, "linkdir"));
    expectRejected(await resolveSourceAnchor(repos, at("linkdir/data.txt", 1)), "PATH_OUTSIDE_ROOT");
  });

  // why: a chain whose LAST hop leaves the root; every hop must be resolved, not just the first.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] PATH_OUTSIDE_ROOT: a chain of symlinks ending outside the root", async () => {
    const { root, repos } = world();
    symlinkSync("../secret.txt", join(root, "c3"));
    symlinkSync("c3", join(root, "c2"));
    symlinkSync("c2", join(root, "c1"));
    expectRejected(await resolveSourceAnchor(repos, at("c1", 1)), "PATH_OUTSIDE_ROOT");
  });

  // why: sibling-prefix confusion. Root is `<base>/repo`; `<base>/repo-evil` starts with the root's
  //   string but is not inside it. A `startsWith(root)` check without a separator accepts it.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] PATH_OUTSIDE_ROOT: symlink to a sibling directory whose name has the root's name as prefix", async () => {
    const { root, repos } = world();
    symlinkSync("../repo-evil", join(root, "evil"));
    expectRejected(await resolveSourceAnchor(repos, at("evil/f", 1)), "PATH_OUTSIDE_ROOT");
  });

  // why: a symlink to the root's parent makes `up/secret.txt` the outside secret.
  // proves: CLAIM(MC6) CLAIM(MC15)
  it("[MC6] PATH_OUTSIDE_ROOT: a symlink to the parent of the root", async () => {
    const { root, repos } = world();
    symlinkSync("..", join(root, "up"));
    expectRejected(await resolveSourceAnchor(repos, at("up/secret.txt", 1)), "PATH_OUTSIDE_ROOT");
  });
});
