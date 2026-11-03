# Native editor bridge, version 1

`dist/editor.html` is the WKWebView entry. Bundle the entire Vite `dist/` tree,
including shared assets. Built asset links are relative, so Swift can use
`loadFileURL(editorURL, allowingReadAccessTo: distDirectoryURL)` with the
bundled `editor.html`. The desktop entry remains `dist/index.html`.
This page mounts the existing TipTap editor, extensions and Yjs persistence,
without the desktop router, sidebar, toolbar or TOC rail. Image editing and
occlusion controls, slash suggestions, math editing and card rendering remain
inside the shared editor. Native owns navigation and formatting controls.

## Host setup and transport

Before loading the page, register a `WKScriptMessageHandler` named `memnoter`
in the page's default JavaScript content world and a `WKURLSchemeHandler`
for `memnoter-file`. The bridge detects Tauri by `window.__TAURI_INTERNALS__`;
Tauri takes precedence. Otherwise `window.webkit.messageHandlers.memnoter`
selects native IPC. Install the handler before JavaScript runs and retain it
for the web view's lifetime. An ordinary browser falls back to Tauri IPC;
it is not a mock backend.

Web to native command example, delivered as a decoded message body:

```json
{"kind":"call","id":"17","command":"get_content","args":{"moduleId":"note-uuid"}}
```

IDs are opaque strings, unique within this page lifetime. `args` is always an
object (`{}` when omitted). Forward exactly `command` and JSON-serialized `args`
to Rust `dispatch(command, args_json)`. Do not rename camelCase keys or wrap
results. The Rust result JSON must be decoded into a JavaScript value:

```js
window.__memnoterBridge.resolve("17", {state: [], updates: [], files: []});
window.__memnoterBridge.reject("17", "Could not read note");
```

`resultJson` means a decoded JSON value, not JSON text. For a Rust JSON string
result, pass a JS string; for unit results pass `null`. Rejection takes a string
and rejects the frontend promise with an `Error`. Each call needs exactly one
reply. Replies may arrive out of order; duplicate/unknown IDs are ignored.
There is no transport timeout or implicit cancellation. Deliver callbacks on
WKWebView's main thread using argument serialization (for example
`callAsyncJavaScript` arguments), never interpolate raw user content into JS.
On reload/navigation, discard outstanding replies from the old page: IDs restart.

Native to web events use the same decoded-value convention:

```js
window.__memnoterBridge.emit("menu", "editor-undo");
```

`listen(event, handler)` subscribers receive `{event, id: 0, payload}`. Its
promise returns an unsubscribe function. Events without subscribers are dropped;
there is no replay. The shared editor handles `menu` payloads `editor-undo` and
`editor-redo` only while it is focused. The editor API below is preferred for
native toolbar actions, especially when the toolbar has focus. Other native
UI updates should use the editor API rather than inventing Tauri event names.

## Lifecycle and editor API

Web to native events are decoded message bodies with this envelope:

```json
{"kind":"event","event":"ready","payload":{"protocolVersion":1}}
```

`ready` fires once per page mount after `window.memnoterEditor` is installed.
It means the API and providers exist; no note has loaded. Native may call
`open` after `ready` and should keep the web view alive across note switches.

```js
await window.memnoterEditor.open("note-uuid");
window.memnoterEditor.exec("bold");
window.memnoterEditor.focus();
window.memnoterEditor.blur();
await window.memnoterEditor.flush();
```

`open(moduleId: string): Promise<void>` requires a nonempty existing note ID.
Calls serialize in arrival order. Before switching it drains the previous
note's images, cards, search indexing and Yjs writes through the shared write
barrier. A save failure rejects and leaves the previous note open. Reopening
the already ready note is a no-op. Resolution means content has loaded, saved
view has restored, and initial `state`/`outline` have been emitted; it does not
focus the editor or mean all future saves have completed. Content load failure
rejects and leaves the editor blank. Errors also emit `error`.

`exec(command, args = {}): boolean` runs synchronously against the ready editor,
without automatically taking keyboard focus from native. Keep the WKWebView
selection alive when showing a native toolbar or link prompt. It returns false
when unavailable, blocked by the write barrier, or inapplicable. Unknown commands
and invalid required arguments return false and emit `error`. `focus()` and
`blur()` also return boolean and emit an error when unavailable. Explicitly call
`focus()` after formatting when native wants the keyboard.

`flush(): Promise<void>` is an additional lifecycle barrier. It temporarily
blocks edits, waits for image operations, card syncing, search indexing and
Yjs writes, and rejects on failure. Await it before dismissing/destroying the
web view or suspending its JavaScript. Keep the page alive and report failure
instead of discarding it. Search indexing uses the existing best-effort timeout;
content/image/card persistence must succeed. Do not edit again between a
successful flush and teardown. `pagehide` cannot guarantee async persistence.
Native should begin flushing before background suspension rather than relying
on an already suspended web view. Do not call flush concurrently with open.

## Formatting commands

All arguments are objects. Omitted arguments mean `{}`.

| Command | Arguments and effect |
| --- | --- |
| `bold`, `italic`, `underline`, `strike`, `code` | Toggle selected text mark or stored mark at caret. |
| `heading` | `{"level":1}`; integer levels 1–6 accepted. Sets heading; shared hierarchy rules can normalize levels (the first heading becomes level 1). |
| `paragraph` | Set paragraph. |
| `bulletList`, `orderedList`, `blockquote` | Toggle wrapper. |
| `codeBlock` | Toggle code block using the desktop slash-menu command. |
| `insertSection` | `{"kind":"sibling"}` for New section or `{"kind":"subsection"}` for Subsection; same shared section insertion as desktop. |
| `indent`, `outdent` | Sink/lift selected list items, matching desktop Tab/Shift-Tab list behavior; false outside an applicable list. |
| `foldCurrentSection`, `unfoldCurrentSection` | Shared desktop fold/unfold commands at the current selection. |
| `removeCard`, `joinClozes` | Shared `removeCloze` / `joinClozes` commands; expose only when the corresponding capability is true. |
| `inlineMath` | Optional `{"tex":"x^2"}`; insert inline formula using the existing command. |
| `mathBlock` | Toggle current line/selection/formula into or out of display math. |
| `link` | `{"href":"https://example.com"}`; set selection link. `{"href":null}` or empty string removes it. Use an explicit URL scheme. |
| `undo`, `redo` | Shared collaboration/history commands. |
| `fold`, `unfold` | `{"id":"heading-toc-id"}`; idempotently set fold state. |
| `focusSection` | `{"id":"heading-toc-id"}`; show that section, move the caret to its heading, and scroll it into view. |
| `focusCurrentSection` | Focus the innermost section containing the current caret, keeping the selection. False before the first heading. No arguments; resolves the current position at execution time. |
| `showDocument` | Clear section focus while keeping the focused heading at its screen position. |
| `scrollToHeading` | `{"id":"heading-toc-id"}`; clear section focus, set caret inside heading (revealing folded ancestors), scroll heading into view. |
| `insertImage` | `{"fileId":"saved-file-uuid","alt":"Optional description"}`; insert block image at selection. |
| `makeCard` | Existing `makeCloze` command, wraps selected text as a cloze; false for unsupported selections. Existing `Q :: A` syntax also creates cards. |
| `find` | `{"text":"term"}`; update shared find highlighting, empty string clears. No web find toolbar is rendered. |

Heading IDs come from the current outline, not note IDs. Positions are
ProseMirror offsets and change as the note changes; use IDs for actions.
For image picking: keep the current note open, call core `save_file` with that
module ID, then immediately `exec("insertImage", {fileId: result.id, alt: name})`.
The image node resolves an uncached receipt with `resolve_card_image`. Never
navigate while the picker/save/insert sequence is incomplete. On initial note
load, existing cleanup may remove files not referenced by the Yjs document.

## Events emitted to native

Events can arrive before `ready` (initial save status) and during open/flush.
Handle only `kind: "event"` as events; command replies are separate callbacks.

| Event | Payload |
| --- | --- |
| `ready` | `{"protocolVersion":1}` |
| `state` | `{moduleId, marks: string[], blockType: string, headingLevel: number|null, headingId: string|null, focusableSection: {pos: number, id: string|null, title: string, level: number}|null, focusedSectionId: string|null, focusedSectionPath: {id: string, level: number, title: string}[], bulletList: boolean, orderedList: boolean, blockquote: boolean, canIndent: boolean, canOutdent: boolean, canMakeCard: boolean, inCloze: boolean, canJoinClozes: boolean, folded: boolean, canFold: boolean, canUndo: boolean, canRedo: boolean, hasSelection: boolean, editable: boolean}` |
| `outline` | `{moduleId, headings: [{id: string, level: number, text: string, pos: number, folded: boolean}]}` |
| `saveStatus` | `{pending: number, failing: boolean, lastError: string|null, imageErrors: string[]}` |
| `error` | `{moduleId: string|null, message: string}` |

`marks` contains active entries from bold, italic, underline, strike, code, link.
`blockType` is the selection's immediate parent node type (e.g. paragraph,
heading, inlineMath). `headingId` identifies the heading containing the caret, or null outside a heading.
`focusableSection` identifies the nearest preceding heading whose section contains
the selection start, including body paragraphs, lists and other nested content.
It is null before the first heading. Section boundaries and normalized heading
levels follow the shared desktop section/hierarchy logic. Its optional ID may
still be pending TOC assignment; `focusCurrentSection` works without one.
`focusedSectionPath` lists ancestors through the focused heading in document order; it is empty for the whole note. Segment IDs can be passed to `focusSection`.
`focusedSectionId` identifies the focused section heading, or null for the whole
note. Both use current outline IDs and update after focus commands, restored
view state, and document edits (including deletion of the focused heading).
List and card capabilities use the same `editor.can()` commands as desktop.
`inCloze` means Remove card is applicable; otherwise show Make card only when
`canMakeCard`. Show Join clozes only when `canJoinClozes`. `folded` means the
shared Unfold current section command is applicable (including a folded
ancestor); otherwise use Fold current section when `canFold`. Commands preserve
editor focus and selection without calling `focus()` or `blur()`.
`state` follows editor transactions; `outline` is emitted
initially and when its serialized headings change. Empty headings without a TOC
ID are omitted until the shared extension assigns one. Outline text contains
raw formula source. Fold state is view state, not an edit to Yjs content.
`saveStatus` is global across notes, including pending saves from prior notes;
`pending` counts queued Yjs updates, not every image/card/index task. `failing`
becomes true after the shared queue's retry threshold. `imageErrors` contains
failed image operations. Use `flush`, not `pending === 0`, as the teardown barrier.
Async query/mutation errors emit `error`; an error event alone does not mean
all persistence has stopped. The save queue retains its existing retries.

Example outline:

```json
{"kind":"event","event":"outline","payload":{"moduleId":"note-uuid","headings":[{"id":"toc-uuid","level":1,"text":"Introduction","pos":0,"folded":false}]}}
```

## File scheme

Current `convertFileSrc` consumers are saved images and card faces. They pass
`FileType.path` from `get_content`/`save_file`, or an absolute path returned by
`resolve_card_image`. Desktop paths remain passed unchanged to Tauri's
`convertFileSrc`.

On native, accepted paths are `<app data directory>/files/<id>` (Unix or Windows
separators accepted), or `files/<id>`. The adapter takes the final `/files/`
suffix from an absolute path; only a single nonempty filename is supported.
`.`/`..`, deeper paths, and paths without `files/` are rejected. Input is an
unescaped filesystem path, never an already percent-encoded URL. Each component
is encoded with `encodeURIComponent`, while the separating slash is retained:

```text
/private/app/files/a #?%é.png
memnoter-file://localhost/files/a%20%23%3F%25%C3%A9.png
```

Swift must accept only host `localhost`, decode each component exactly once,
require exactly `files/<id>`, reject traversal/separators after decoding, and
resolve inside its own app data directory. Never trust the original absolute
prefix or serve arbitrary filesystem paths. Return the saved image bytes and
correct MIME type, fail missing assets, and support concurrent requests and
cancellation. Ensure WKWebView's origin/CSP permits this custom image scheme.
External link clicks use `window.open` in native; Swift should handle WKUIDelegate
new-window navigation and route allowed external URLs to the system browser.

## Core commands reached by the editor entry

The complete reachable core command set is:

| Command | Arguments |
| --- | --- |
| `modules` | `{}` |
| `get_content` | `{moduleId}` |
| `cleanup_files` | `{moduleId, fileIds, expectedState, expectedUpdateId}` |
| `add_update` | `{moduleId, bytes}` |
| `save_compaction` | `{moduleId, newState, updateId}` |
| `save_file` | `{moduleId, bytes, mimeType}` |
| `read_file` | `{moduleId, fileId}` |
| `resolve_card_image` | `{fileId}` |
| `sync_cards` | `{moduleId, cards}` |
| `card_schedules` | `{moduleId}` |
| `index_note` | `{moduleId, body, math, version, backfill}` |

Results and errors are exactly the existing Tauri command results. Imported
helpers for desktop review/backfill are not invoked by this entry. In particular,
it does not call `due_counts`, `unindexed_modules`, `set_editor_history`, updater,
app-version, window, process, or menu plugin commands.

All binary values already use JSON arrays of integers 0..255. This includes
`save_file.bytes`, `add_update.bytes`, compaction `newState`, `get_content.state`
and update bytes, cleanup `expectedState`, and `read_file.bytes`. No raw Tauri
IPC, ArrayBuffer transfer, base64 conversion, or binary contract change is
introduced. Yjs document/schema extensions remain shared with desktop.

## Native view persistence

Before loading editor.html, inject `window.__memnoterViewState` at document
start with the last decoded `viewState` event payload (or `{}`). Native stores
this payload in app preferences; custom-scheme origins cannot rely on Web
Storage. `viewState` contains the shared app state, including `viewByModule`:
scrollTop, block scrollAnchor, selection anchor/head, focusedSection and
foldedSections. Positions and folds have the same semantics as desktop.
`open` captures the outgoing view before switching; `flush` captures pending
view changes synchronously before its async write barrier. Native must retain
the event handler until that barrier completes. Sidebar visibility and selected
native destination are stored separately by the SwiftUI host.

Section IDs in native state and outline are opaque. Empty headings skipped by
the shared TOC use a `native-section:<position>` fallback, refreshed on every
transaction. Pass the latest ID to `focusSection`; do not persist these IDs.
