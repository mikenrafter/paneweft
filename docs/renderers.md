# Writing a repo-owned renderer

A *custom view* shows a captured value with code the repository owns. The standard fallback (a shape or a list with the same facts) is always
stored and always shown beside it, so an agent reading text and a person without trust for the renderer see the same facts. Normative rules:
`docs/v1-red-contract.md` section 12. This page is the author's guide and states what the host does today.

## Files

`renderers/<id>/` under a root registered with `paneweft repo add` holds exactly three files:

| File | Content |
|---|---|
| `renderer.json` | `{"id": "<id>", "apiVersion": 1, "title": "...", "payloadSchema": { ...JSON Schema... }}` |
| `bundle.js` | one classic script (no modules, no imports, no network) |
| `style.css` | the stylesheet |

`<id>` is lowercase letters, digits and dashes, starts with a letter, at most 64 characters. The payload schema may use local `$ref`s only.

## The two digests

A view declares the renderer with its id, API version and two digests. Print them for the directory instead of computing them by hand:

```sh
paneweft renderers digest --repo cm --id mapping-card
```

```
renderer mapping-card of cm (apiVersion 1, not trusted)
assetDigest: 0f2a69c4...
payloadSchemaDigest: c0dbe898...
TypeScript: defineRenderer({ id: "mapping-card", apiVersion: 1, assetDigest: "0f2a69c4...", payloadSchemaDigest: "c0dbe898..." })
Rust: paneweft::Renderer::<Payload>::new("mapping-card", 1, "0f2a69c4...", "c0dbe898...")
then collect again; the owner reviews the files and runs: paneweft renderers trust --repo cm --id mapping-card --digest 0f2a69c4...
```

`--format json` prints the same as `paneweft.renderer-digests/1`. The asset digest is sha256 over the lines `<file>\0<sha256 of the file>\n` for `renderer.json`,
`bundle.js`, `style.css` in that order, so ANY edit of the three files moves it. The payload schema digest is sha256 of the canonical JSON (keys sorted at
every level, no whitespace) of `payloadSchema`, so only an edit of the schema moves it.

**A collection checks your declaration.** When a collected view declares a renderer whose files under the registered root hash to other digests, the job
carries a diagnostic of category `renderer` (`diag-renderer-1`, ...) naming the view, both digests and this command. It does not fail the collection (the
fallback is intact); the viewer would show the value as *changed since capture* (below). A repository root that is not registered cannot be compared, and
says nothing.

## Editing a renderer, and what older snapshots say

The renderer's files are **not** stored with a snapshot. Trust follows the reviewed bytes of the files that exist now (`paneweft renderers trust` refuses a
digest that is not the current one), so a value captured with other bytes cannot run bytes the owner has not reviewed. A value whose renderer was edited
since it was captured shows its standard view and the state `changed`:

> the renderer "mapping-card" changed since this value was captured: it was captured with digest 0f2a69c4a3f2..., the files under the registered root hash
> to 3be1c0a7d9e4... now. ... Collect the example again to capture it with the current renderer; the owner then reviews the files and runs: paneweft
> renderers trust --repo cm --id mapping-card --digest 3be1c0a7...

The workflow after an edit: `paneweft renderers digest` -> copy both digests into the declaration -> collect -> the owner trusts the new digest. Snapshots
captured before keep their facts and their standard view; only the custom rendering is gone. (The alternative, storing the renderer's files with each snapshot,
would make superseded code runnable on a trust that was replaced; it was not built.) `view_result` and `views` print the state, the digests and the command.

## The page

The host serves a generated document at `/renderer/<assetDigest>/<token>/index.html` into an `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`
(opaque origin: no cookies, no storage, no parent access, no network). The document is:

```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>renderer</title><link rel="stylesheet" href="style.css"></head>
<body><main id="root"><svg id="card" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="renderer"></svg></main><script src="bundle.js"></script></body></html>
```

Draw into `#root` (create what you need). The empty `<svg id="card">` is the mount point of the repository's own mapping-card renderer and stays for it; ignore
or remove it. The response headers are `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'self'`: no inline script, no inline `<style>` or `style=` markup, no `fetch`, no WebSocket. Keep keyboard
access (focusable elements, Enter or Space to act): the viewer frames it in a tab order of its own.

## The message protocol

1. The host posts to the frame window `{protocol: 1, type: "bootstrap", nonce, frameId, viewId, snapshotId}` with ONE `MessagePort` (`event.ports[0]`). Listen for it
   with `window.addEventListener("message", ...)`; every later message uses the port.
2. The renderer sends `ready` with `body: {nonce}` (the same nonce) as its first message.
3. The host answers `init` with `body: {payload, objects, theme, locale, label}`: the payload you declared, the object ids you may name (below), `"light"`,
   the viewer's locale and a label.

Every message, both ways, is an object `{protocol: 1, type, frameId, viewId, snapshotId, requestId, seq, body}`: `frameId`, `viewId` and `snapshotId` echo the
bootstrap, `requestId` is a string of 1 to 128 characters, `seq` is an integer that rises with every message you send (the first is 1), `body` is an object.

| Renderer sends | `body` | Effect |
|---|---|---|
| `ready` | `{nonce}` | starts the session; the host answers `init` |
| `resize` | `{height}` (CSS pixels) | the frame is resized, clamped to 40..1200 |
| `select_item` | `{object}` | accepted if `object` is permitted; no host action in week one |
| `open_object` | `{object}` | the captured record of `object` opens in another pane |
| `request_page` | `{}` | accepted; no host action in week one |
| `render_error` | `{message}` | the viewer shows the message (300 characters) beside the fallback |

A message is rejected, counted and shown (`data-pw="renderer-notice"`, state `protocol-error`, the last reason) when it is not an object of this shape, has
another protocol, frame, view or snapshot, a `seq` that does not rise, a type other than the ones above, a body over 64 KiB, an `object` outside the permitted
list, a wrong nonce in `ready`, or more than 50 messages in one second. A closed frame or a message from another window revokes the port; a frame that loads a
second time (navigates itself) is disconnected (`revoked`). Nothing a rejected message asked for is done. There is no message that fetches a URL, reads a file,
runs a command, evaluates code, calls an MCP tool or starts a collection.

## `objects`: which records a renderer may name

The author passes the references of the captured objects the renderer may open: TypeScript `view.custom(renderer, payload, fallback, [view.self()])`, Rust
`cx.custom(&renderer, payload, fallback, &[reference])`. Each becomes the **string id** of the object in the capture (`"o1"`), and the stored view lists them
as `objects: ["o1"]`, not as `{object: "o1"}`. The host sends the same array in `init.objects`, and `open_object` / `select_item` accept only a string that is
in it. A reference that was not captured (a bound refused it) is left out. The viewer resolves an accepted id to the entity of that object and opens it.

## States

`paneweft views`, `paneweft result` and the viewer report one state per custom value: `ready` (trusted digest, files present and equal, payload valid),
`untrusted` (the owner has not trusted this digest; the exact `paneweft renderers trust` command is printed), `changed` (see above), `missing-asset` (the files
are not under the registered root), `incompatible` (an API version this host does not speak), `failed` (the payload does not satisfy the registered schema).
Whatever the state, the standard view of the same facts is shown.
