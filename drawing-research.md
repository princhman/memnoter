# iPad drawing: research and proposed scope

Date: 2026-11-08. Status: research followed by a native editable drawing milestone. The final section describes the current implementation; earlier prototype sections record the progression.

## Confirmed product requirements

- Native, smooth Apple Pencil input is the priority; Apple Notes and Goodnotes are experiential references, not a measured parity claim.
- First version opens an embedded drawing in a full-screen editor and returns to the note.
- Editing can launch on iPad first. Future editing on every platform is a requirement, so storage must preserve editable information.
- Short handwritten explanations/diagrams and long handwritten notes are equally important.
- Use the existing local-first Yjs/yrs architecture where appropriate.

## Recommendation

Use PencilKit for live iPad ink, Tiptap for placing drawing embeds, and the existing Rust/yrs core for durable storage and synchronization. Before implementing the shipping format, run a bounded portability experiment: capture a deliberately small set of PencilKit tools, export a versioned portable stroke representation, render and modify it in a non-Apple renderer, and reopen that modification in PencilKit.

Keep the original PKDrawing as an exact native sidecar. Do not describe that sidecar as a cross-platform drawing format. A preview image is a display derivative, not editable source. PencilKit's documented stroke access makes an adapter plausible; it does not establish lossless visual or behavioral equivalence across renderers.

If that experiment fails, make the tradeoff explicit: either constrain the supported tools until conversion works, or build a custom portable ink engine. A native-only archive with a promise to solve conversion later is not the recommended shipping foundation for the stated requirements.

## What the repository already supplies

- `apps/ios/Sources/WebHost.swift`: native SwiftUI/UIKit host for WKWebView, typed web events, module-generation guards, serialized open/flush and file URL handling. A full-screen native editor fits the architecture.
- `apps/shared-ui/src/lib/editor-schema.ts`: common Tiptap schema, including Yjs collaboration. Its explicit warning matters: all editors of a document must know its nodes/attributes or they can delete unsupported content.
- `apps/shared-ui/src/editor-host/protocol.ts` and `scripts/generate-bridge-protocol.mjs`: canonical bridge contract and generated Swift bindings. Extend these rather than introducing ad hoc messages.
- `apps/ios/Sources/CoreClient.swift`: actor-isolated Rust access through UniFFI. There is already a native route to Rust; a second Swift CRDT dependency is not inherently necessary.
- `crates/memnoter-core/Cargo.toml`: yrs 0.24. `apps/shared-ui/package.json`: Yjs 13.6.x.
- `crates/memnoter-core/src/files.rs`: immutable UUID assets with atomic file writes and transactional file/upload records.
- `apps/shared-ui/src/lib/sync/files.ts` and `apps/ios/Sources/SyncClient.swift`: encrypted asset transfer separate from document updates.
- `crates/memnoter-core/src/asset_refs.rs`: reference retention across note copies, undo history and compaction. Current discovery reads `fileId`; additional drawing asset references need explicit support.
- `crates/memnoter-core/src/backups.rs`: hard-linked backups assume immutable assets. Overwriting a drawing file would invalidate this assumption.
- `apps/ios/project.yml`: iPad-only native host, minimum iOS 17. The installed SDK is 27.2, but the retained simulator pool is 26.5; SDK availability does not imply runtime availability.

These are source inspections, not executed compatibility or performance checks.

## Drawing engines evaluated

### PencilKit: preferred first experiment

Apple provides the low-latency native canvas, ink tools, erasing, selection, and drawing model. Apple identifies PencilKit as the framework used for drawing in Notes. Use a retained `PKCanvasView` and a native tool picker hosted through UIKit/SwiftUI; preserve view identity instead of rebuilding the canvas as state changes. [PencilKit](https://developer.apple.com/documentation/pencilkit), [Introducing PencilKit](https://developer.apple.com/videos/play/wwdc2019/221/).

Its advantages are input quality and native interaction. Its limitation is that native drawing data and ink rendering are Apple-specific. Native capability does not automatically provide Notes' complete feature set or Goodnotes' behavior.

Start with a small supported tool contract: pen, marker/highlighter, whole-stroke eraser, undo/redo, colors and widths. Prove lasso/move and partial erasing in the adapter experiment before enabling them in the shipping portable format. These operations are important because conversion bugs can resurrect erased content or move it incorrectly.

### PaperKit: revisit for structured markup

PaperKit builds on PencilKit and adds shapes, images and text boxes, with a combined data model and configurable feature set. It is attractive if the product expands into annotation or richer diagrams. Apple demonstrates full-screen-style controller integration and saving a thumbnail alongside native markup for compatibility. [Meet PaperKit](https://developer.apple.com/videos/play/wwdc2025/285/), [PaperKit](https://developer.apple.com/documentation/paperkit).

The installed SDK declares PaperMarkup and the iOS markup controller available from iOS 26. That adds an OS-support decision to an app currently targeting 17. Its larger native object model also increases the cross-platform adapter scope. For ink-first portable drawings, it is not the default choice.

### Tiptap example and web drawing libraries

The linked Tiptap page documents a canvas drawing node and directs developers to node views. It establishes a way to embed an interactive object in rich text; it supplies no evidence of Apple Notes-like input quality. Its demo implementation was not fully audited in this research. Reuse the node-view integration concept, not an assumption that the demo is a production ink engine. [Drawing example](https://tiptap.dev/docs/examples/advanced/drawing), [Node views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views).

Excalidraw is an embeddable diagram/whiteboard editor and is worth considering if diagrams become the primary task. tldraw offers a broader canvas SDK, but its current documentation requires a production license. Neither establishes Pencil latency parity without measurement. [Excalidraw](https://github.com/excalidraw/excalidraw), [tldraw license](https://tldraw.dev/community/license).

`perfect-freehand` generates pressure-sensitive stroke outlines; it is a useful web-renderer experiment, not a complete engine with storage, palm handling, tools and undo. [Repository](https://github.com/steveruizok/perfect-freehand).

### Custom native engine

Offers direct control over a portable stroke model and brush behavior, at the cost of building prediction, event sampling, rendering, erasing, selection and tool UX. Apple exposes low-latency event scheduling for custom engines, but emphasizes minimal event-handling work and profiling. Reserve this option for a demonstrated PencilKit portability blocker. [Low-latency dispatch](https://developer.apple.com/documentation/uikit/uiupdatelink/wantslowlatencyeventdispatch).

## PencilKit portability experiment

Use a fixed document coordinate system independent of device pixels, viewport size and zoom. Preserve stroke order, brush/version, resolved color, width, transform, opacity, and control-point data including position, time, force, azimuth, altitude and point size. Do not treat PencilKit spline control points as raw touch samples and feed them unchanged to an unrelated stroke smoother.

Handle masks as geometry. Partial erasure can create holes or split strokes with distinct masks/transforms. Merely exporting the centerline or its visible parameter ranges does not preserve every erased edge. PencilKit's richer inks can also depend on native render state. [Stroke inspection and masks](https://developer.apple.com/videos/play/wwdc2020/10148/), [Stroke points](https://developer.apple.com/documentation/pencilkit/pkstrokepoint-swift.struct).

Acceptance fixtures should include dots, fast curves, tiny handwriting, overlapping translucent markers, transformed selections and partially erased thick strokes. Verify iPad → portable → web edit → iPad, including undo and reopen. Begin with pen and whole-stroke erasure, then increase tool coverage only when the round trip works. Preserve native bytes throughout the experiment.

On runtime 26.5, do not assume the stable stroke identity APIs introduced in iOS 27 exist. Establish application-owned IDs and verify change detection for native undo, erasure and selection transforms. Avoid repeatedly scanning and reserializing all strokes after every change on long pages. [PencilKit updates](https://developer.apple.com/documentation/updates/pencilkit).

## Yjs, yrs and Swift: separate synchronization from rendering

Yjs/yrs manage shared data and convergence. They do not render ink, remove Pencil latency, or turn a PKDrawing binary into mergeable strokes. Storing one binary under a shared map key still makes concurrent whole-drawing replacements conflict at that key.

YSwift exists and wraps Yrs with interoperable Swift bindings. In this app, prefer extending the existing Rust/UniFFI boundary first. Evaluate YSwift only if native shared-type observation or mutation justifies another binding and packaging dependency; verify interoperability against this repository's actual versions. [YSwift](https://github.com/y-crdt/yswift).

Proposed logical model, pending the portability experiment:

- Tiptap `drawing` block: stable drawing ID, schema version, display geometry and preview reference. It is selectable and atomic from the text editor's perspective.
- Drawing data outside the ProseMirror XML tree: page IDs/order, page sizes, per-page stroke order, and immutable stroke records keyed by application-owned IDs.
- A stroke record holds a complete geometry revision, or references an immutable geometry asset. Do not make every pointer sample a separate CRDT item.
- Replacing a stroke after a transform/erase is one application operation. A Yjs transaction groups local observation but does not make competing multi-field writes semantically conflict-free; design the record boundaries accordingly.
- Concurrent additions must survive. Define delete-versus-transform and simultaneous-transform behavior explicitly. CRDT convergence alone does not guarantee user-intended drawing results.

Prototype this as a namespaced shared root within the existing note Y.Doc so existing update transport can potentially carry it. Verify every encode, decode, snapshot, compaction, export and restore path preserves additional roots. Large documents may later justify separate drawing documents, but those require explicit routing, lifecycle and backup changes.

For the first iPad milestone, simultaneous editing need not be exposed. Nevertheless, preserve concurrent offline native revisions as recoverable branches instead of silently replacing one. This is a fallback safety mechanism, not stroke-level collaboration. [Y.Map](https://docs.yjs.dev/api/shared-types/y.map), [Y.Array](https://docs.yjs.dev/api/shared-types/y.array).

Keep live strokes local to the canvas. Submit finalized operations/checkpoints asynchronously. Never replace the active PKDrawing on every shared-document notification. Queue remote changes until a safe input boundary. Undo needs one owner per context: PencilKit while drawing, note history for inserting/removing embeds. If drawing operations later use a CRDT undo manager, scope transaction origins and avoid recording the same action twice. [Yjs undo](https://docs.yjs.dev/api/undo-manager).

## Proposed first product scope

Insert Drawing at the current note position. Open a full-screen editor, dismiss the text keyboard, retain the original note selection/scroll, and return through Done. Drawings remain editable on iPad and viewable elsewhere.

Use one drawing document with multiple bounded pages. Short content starts with one page; long handwriting can add, navigate and reorder pages. The note shows a bounded preview with page count and opens the document, rather than rendering a gigantic image of all pages. Lazy-load page canvases and generate previews per page. Rotation or a narrow window changes the viewport, not ink coordinates.

Pencil draws; fingers navigate by default. Provide an explicit finger-drawing setting. Include pan/zoom, undo/redo, persistent tool selection, clear saving/error states, local draft recovery and basic page management. Prefer an opaque paper surface with explicit colors for the first version, so preview and native rendering agree in light/dark themes. Pencil interactions should respect supported hardware and system preferences. [Apple Pencil guidance](https://developer.apple.com/design/human-interface-guidelines/apple-pencil-and-scribble), [Pencil interactions](https://developer.apple.com/videos/play/wwdc2024/10214/).

Defer drawing directly in flowing text, handwriting recognition/search, typed-text annotation, PDF import, shape recognition, audio, realtime collaboration and a full cross-platform editing UI. These deferrals do not relax the requirement to preserve portable editable data.

## Persistence and failure behavior

Maintain an atomic local draft independently of the live web editor. Debounce checkpoints, bound outstanding work, and flush at safe lifecycle boundaries. Rendering/export and persistence must not monopolize the drawing thread; profile the actual APIs rather than assuming moving them to a Task makes them background work.

Persist new immutable source/preview assets before publishing references. Publish a consistent revision descriptor, then acknowledge its document save. Partial asset arrival on another device should show a loading state with the last valid preview. Done must distinguish locally saved from cloud uploaded; offline drawing must work. A failed save retains the draft and offers retry.

Prevent callbacks from an old drawing session from updating a new module. Resolve inserts through a stable placeholder/node identity rather than a stale numeric selection position. Remote deletion must not resurrect the embed when Done is pressed; preserve the recovered drawing separately.

Extend reference retention to every source, preview and native sidecar, including references in non-XML shared roots and undo/revision history. Cover cross-note copies, source-note deletion, backup/restore and orphan cleanup. Never overwrite immutable file IDs. Check source-content compatibility before opening a native archive; show the preview if unsupported. [Ink compatibility](https://developer.apple.com/documentation/pencilkit/supporting-backward-compatibility-for-ink-types).

## Implementation gates and evidence

1. Native input baseline on a physical iPad with Apple Pencil. Compare the same handwriting tasks in Memnoter and Apple Notes; use Goodnotes if available. Record hardware, OS and Pencil model. Simulator work can verify layout and persistence, not palm rejection or Pencil latency.
2. Portability round trip for the supported tools, including web-side modification. This gates the format decision.
3. Durable page model and CRDT interoperability through the current Rust/JS pipeline, with reopen, duplicate/out-of-order update delivery and concurrent offline edits.
4. Embed integration, stable insertion and return focus, preview rendering on desktop, sync and full recovery/backup behavior.
5. Long-document profiling: increasing stroke counts and page counts, rapid strokes while saving/syncing, page switches, zoom and memory pressure. Define supported limits from measurements.

At 120 Hz a frame interval is approximately 8.3 ms; at 60 Hz it is 16.7 ms. These are display intervals, not promised end-to-end Pencil latency. Capture frame-time/hitch measurements and input-to-visible-ink evidence separately. Do not set a numerical latency claim from a simulator recording.

The next implementation slice should establish the native baseline and portable round trip together. The highest uncertainty is preserving editable, faithful strokes across platforms, not adding an Insert Drawing button.

## Second-pass risks and decisions

This is a risk inventory, not a claim that every possible failure has been excluded.

1. **Tool-up is not final data.** Apple documents that final force estimates may arrive after `canvasViewDidEndUsingTool`. Use drawing-change callbacks, including changes after tool-up, to schedule persistence. A stroke-end-only save can miss corrected ink. [Delegate timing](https://developer.apple.com/videos/play/wwdc2019/221/?time=1620).
2. **Cancellation is not write ordering.** Cancelling a debounce task cannot undo a write already underway. Serialize writes and reject stale revisions; do not let an old autosave overwrite an explicit Done save.
3. **Two owners of one document.** A native yrs document and a web Yjs document must exchange updates with distinct origins and exactly one durable acknowledgement path. Otherwise changes can loop, duplicate outbox entries, or appear saved while one replica remains stale. Prefer the existing core boundary over an unrelated Swift replica.
4. **Undo is more than an inverse snapshot.** Restoring a whole previous drawing can remove another device's strokes. Scope local operations and explicitly handle redo after concurrent changes. Native and CRDT undo cannot independently record the same action.
5. **Stable IDs are runtime-dependent.** iOS 27 adds native stroke identity. On 26.5, matching strokes after erasure, native undo or transforms needs an application strategy; array index is not identity. Exported prototype strokes intentionally do not claim durable IDs.
6. **Spline points are not sampled input.** Resmoothing PencilKit control points through another engine changes handwriting. Variable point size, opacity and transformations matter even with a simple brush. Inspect output before adopting a stroke generator.
7. **Eraser masks are not just missing centerline segments.** Thick-stroke edges can be partially erased. A centerline-only export may restore ink the user removed. Unsupported masks must fail explicitly until implemented.
8. **Brush opacity and compositing.** Marker strokes may composite in groups; rendering each independently can darken intersections. An apparently correct geometry export is not sufficient. Start with a solid monoline tool in the prototype.
9. **Dark-mode color conversion.** Native ink can adapt to appearance; a PNG or web renderer does not automatically use the same rules. Decide whether colors are document colors or semantic theme colors, and export with an explicit appearance. The prototype uses white paper and a light native canvas. [Appearance guidance](https://developer.apple.com/design/human-interface-guidelines/apple-pencil-and-scribble).
10. **Viewport coordinates and zoom.** Cropping or rotating an embed must not modify stored ink coordinates. Preview bounds must include stroke widths and negative coordinates; page-sized clipping can silently omit ink. Raster size must be capped independently of zoom.
11. **Canvas geometry is not a page limit.** Setting scroll content size does not establish a validated clipping rule for all native input. A production page editor needs explicit page boundaries, page growth rules and navigation. The prototype records nominal dimensions and preserves full native drawing bounds when exporting a preview.
12. **Large-document work hides in innocent callbacks.** Reading every stroke, producing JSON, serializing native data or rasterizing on each change can dominate frame time. Native `Task` creation alone does not move that work off the main actor. Benchmark serialization and diffing separately from drawing.
13. **Asset arrival is not document arrival.** Preview, portable geometry and native archive can arrive in different orders. Publish a consistent revision manifest; retain a known-good preview and distinguish missing source from an empty drawing.
14. **Atomic publication is not rollback.** Assets saved before a failed document commit can become unreferenced rows. Track/collect these without deleting assets still reachable from undo, copied notes or offline revisions.
15. **Deletion while editing.** Remote module deletion or database restore can invalidate the editor beneath a full-screen canvas. Validate the target before committing, retain recovery data, and never automatically recreate the deleted embed. A restore also needs a generation token, not just a matching module ID.
16. **Copy behavior is a product rule.** Copying a drawing to another note must explicitly fork editable identity or intentionally link it. Reusing a drawing ID accidentally makes editing one copy modify the other.
17. **Backups and local drafts differ.** A prototype file outside managed assets is not covered by Memnoter's normal database backup/restore or E2E sync. Its UI must say so, and module deletion/restore cleanup must be designed before shipping. iPadOS device backups have separate behavior from app backups.
18. **Sensitive local data and export.** Production drafts need an explicit iOS file-protection policy, size limits and deletion behavior consistent with notes. Exporting readable JSON intentionally leaves the app's encrypted sync boundary. Do not call that export encrypted or treat native serialization as encryption.
19. **Corruption must not create an empty replacement.** A decode/read failure must keep the original file, disable editing, and allow leaving the editor. Do not display an empty writable canvas and autosave over the only recoverable copy.
20. **New schema rollout.** Desktop, review surfaces, hidden/background editors, clipboard/import/export and backfill/indexing paths need compatible handling before drawing nodes ship. A new top-level shared root survives whole-document encoding in the inspected compaction path, but current XML-only asset discovery still misses its references.
21. **ProMotion is not a latency guarantee.** Refresh rate can change with power, thermal conditions and system policy. A blank canvas benchmark is insufficient; test input during autosave, sync, navigation and memory pressure on supported devices.
22. **Accessibility and input ownership.** Finger drawing, Pencil drawing, pan, zoom, system Scribble and selection can compete. Provide an explicit finger mode, labeled controls, and a usable compact layout. Test real palm rejection and supported Pencil gestures physically.

## Prototype delivered in this worktree

Entry: a note's **Note actions → Drawing prototype**. One local scratchpad is retained per note. It opens full screen, uses a retained PKCanvasView with solid monoline ink, three colors, three widths, a whole-stroke eraser, undo/redo, native scrolling/zoom and an explicit finger-drawing toggle. Done flushes the draft; autosave debounces drawing-change events and includes a background checkpoint. Draft writes are atomic and revision-ordered. Read failures preserve the file.

**Insert preview** crops the actual drawing bounds with padding, caps raster dimensions, flattens onto white, and inserts through the existing image path. The inserted image follows normal note/image persistence and sync. It is an independent snapshot; tapping it does not reopen the native source. Reopen the scratchpad from Note actions to continue drawing. An explicit action may insert a new snapshot after further editing.

**Export strokes** writes versioned JSON with the native spline control points, time/force/size/opacity/angles, native ink identifier, ink color, affine transform, creation time, random seed, and clipping paths including their fill rule. Unknown path commands reject export. This is an inspection/interchange experiment, not a proven cross-platform editor or stable stroke identity schema. Rich brush-specific render state is not covered by this first format.

The first live export attempt exposed a gap in the initial assumptions: native canvas output failed an exporter restricted to unmasked monoline strokes, despite the constructed fixture passing. Inspection of the saved real-input export identified the cause: a stroke made with the monoline tool reopened with the ink identifier `com.apple.ink.pen`. Tool identity is not a safe invariant for persisted stroke identity. The exporter now retains full mask commands and the native ink identifier instead of assuming those restrictions survive native persistence. The test checks clipping preservation explicitly, allowing PencilKit to normalize a closed mask's start corner. This is why real-input fixtures and cross-renderer round trips remain a shipping gate.

Limits: one drawing surface per note, starting at 1024×1440 document points and growing to cover the viewport and existing ink; no page management, editable embed node, portable import, web renderer, stroke-level CRDT integration, app backup integration, or synchronized editable source. Native draft serialization still runs on the main actor after idle; this must be profiled/redesigned for long documents. The simplified toolbar does not yet implement Pencil double-tap/squeeze/tool-picker behavior. Local drafts remain after note deletion and are not part of app restore. These are deliberate prototype boundaries, not finished product behavior.

### Verification

- Built Rust device/simulator libraries and regenerated UniFFI bindings through `scripts/build-ios-core.sh`.
- Built the bundled shared web editor through `scripts/build-ios-web.sh`.
- Xcode simulator build and both focused DrawingPrototypeTests passed on retained iPad `11A89810-6F0B-48A8-8A30-B699FDB4C5F0`, iOS 26.5. The tests cover real atomic draft file writes/reopen, stale revision rejection, module isolation, and exported geometry/color/pressure/transform/clipping.
- Manual device-tool verification used an isolated UI-testing data directory: created a note, opened the canvas, enabled finger drawing, drew a stroke, undid/redid it, inserted its preview, relaunched, and reopened both the persisted note image and editable native draft. Whole-stroke erasing removed the stroke; undo restored it.
- Exported the real reopened stroke through the iPad Files picker and inspected the resulting JSON: version 1, one stroke, twelve spline points, native pen identifier. This verifies export delivery and native persistence behavior, not cross-renderer equivalence.
- No physical Pencil latency, palm rejection, hardware gesture, zoom interaction, long-document profiling, cloud sync delivery, or background force-kill guarantee is claimed. The retained simulator was already booted and was left running.

### Drawing-area correction after physical iPad feedback

The first physical-device check reported good writing but a sharp right/bottom clipping boundary. A new real-UIKit regression reproduced it: the initial 300-point presentation pass selected zoom 0.35 permanently, leaving a 358.4×504 drawable area after expansion to a landscape viewport. The surrounding white view remained larger, disguising the restriction.

Removed automatic first-layout zoom. The native canvas now retains the user's zoom and grows its document extent to cover the viewport at that zoom and all existing ink. Empty drawing bounds are explicitly excluded because CGRect.null carries an infinite origin. Export uses the expanded document size. Existing stroke coordinates are not transformed.

The regression failed on the original implementation and passes with the correction; all three DrawingPrototypeTests pass. Simulator input verified complete strokes along the visible right and bottom edges. The orientation command reported success but the simulator screenshot stayed portrait, so landscape resizing is covered by the UIKit regression rather than a claimed landscape UI check. The signed device build passed and was successfully reinstalled on the paired physical iPad Air.

## Usable editable drawing milestone

The user's physical iPad check confirmed good writing after the canvas correction. The next implementation keeps that native input path and adds the note workflow:

- **Insert drawing** creates an identifiable embed at the note selection without replacing a selected image. Multiple drawings in one note are independent.
- Tap an embed to reopen its editable native source. **Done** updates that same embed's preview and source. **Close** keeps changed work as a local recovery draft; reopening recovers it. Untouched new placeholders can be discarded.
- Apple's native tool palette supplies ink/color/width controls, erasing and lasso selection. Canvas and picker cap content compatibility at version 2. Drawing options include finger input, adding vertical writing space, Save a copy and geometry export.
- **Import scratchpad** is available when the earlier per-note scratchpad exists, preserving that original file while creating a new editable embed. Earlier preview images remain snapshots.

### Persistence and compatibility

Published sources are immutable managed JSON assets with version 1, native PKDrawing bytes, document dimensions and an inspection geometry export. PNG previews are separate immutable assets. The image schema stores one `drawing` attribute containing the paired source/preview IDs so competing attribute updates cannot assemble a mixed revision. The conventional `fileId` remains a preview fallback. New renderers use the paired preview ID; existing image ID copy repair gives copied embeds independent identities.

These assets follow existing file encryption, upload and backup mechanisms. Reference discovery now includes both source and preview. A live relaunch check caught startup cleanup deleting a source when it only recognized image file IDs. The fix updates UI discovery and makes the Rust cleanup boundary independently refuse deletion of current note references. Foreign-note retention also covers both drawing assets across removal, compaction, restart and owner deletion. The owner-cleanup regression was run with the guard removed and failed, then passed after restoration.

Local drafts use atomic, revision-ordered files per note/embed and include the source revision they were based on. Failed publication retains them. Retrying a failed note acknowledgement reuses the uploaded asset IDs. Missing/corrupt source data does not create a writable empty canvas. A late native stroke update during saving retains recovery data and asks for another Done action rather than treating an older upload as current.

Observed stale revisions or removed embeds are rejected at publication; Save a copy retains the work. This is **revision-level conflict detection, not concurrent stroke merging**. Two offline devices editing the same source can still compete at the shared revision attribute; a future stroke-level model or explicit revision graph remains necessary for full multi-device editing semantics. Local recovery drafts are not cloud synced or included in app backups.

Desktop clients built from the updated shared schema show previews and preserve the source references; editing is iPad-only. Older clients that lack drawing schema/reference handling have not been validated. All clients opening these notes need the updated schema/core before treating this as a general multi-platform release.

The native archive preserves Apple rendering fidelity. The geometry export still lacks a tested cross-renderer import/edit round trip, stable portable stroke identities and some rich-ink render details. This milestone does not claim those portability gates are solved, nor does it introduce YSwift or duplicate the existing CRDT core.

### Validation for this milestone

- Shared UI full suite: 273 tests passed before the cleanup integration correction. The subsequent focused cleanup/loading/drawing/command suite passed all 30 tests after the correction. TypeScript/Vite production build and project style lint passed.
- Rust core suite: 68 unit tests plus 7 dispatch tests passed, including source/preview retention. The owner cleanup regression independently failed without its guard and passed with it.
- Native checks cover actual UIKit resize/zoom, atomic draft ordering, native source upload/reopen after draft removal, preservation/reuse after failed publication, exported geometry/clipping and missing-source read-only behavior.
- Manual retained-iPad simulator checks: insert a drawing, use the native palette, draw, Done, relaunch, tap to edit, Close with a local change, reopen recovered changes, Done without duplicating the embed, and relaunch/reopen the updated managed source. Also imported the earlier scratchpad without altering its original file.
- Physical Pencil input quality was reported by the user for the earlier canvas baseline. This session does not claim new physical palette, live cloud transfer, old-client compatibility, long-document performance or portable renderer verification.

## Custom toolbar and appearance correction

Physical-device feedback rejected the system tool picker and the dark header. The editor now uses its own compact floating toolbar with pen, pencil, marker, bitmap eraser, lasso, six fixed sRGB colors and stroke-width controls. No PKToolPicker is instantiated or observed. Direct Pencil interactions handle the supported tool-switch preferences through the custom tool state.

The canvas extends behind small floating Close, Done and options controls. There is no navigation/title/status bar or reserved dark strip. Only the drawing editor opts into light appearance; other app screens retain their theme. Native ink tools receive literal document colors, and previews render against the light canvas traits on white paper. Existing stroke colors are preserved.

All six native DrawingTests pass, including a raster check that selected blue ink renders with the same RGB values in light and dark appearance. Simulator visual inspection with the system set to dark confirmed the white edge-to-edge canvas, custom toolbar and absence of the black header. The simulator's system appearance was restored to light afterwards. The signed physical-iPad build passed.

## Width-fitting vertical paper

The paper now fits the current viewport width and scrolls vertically. The viewing scale follows available width after layout and rotation; pinch zoom, horizontal bounce and horizontal scrolling are disabled. Existing stroke coordinates are unchanged. When opening an older free canvas, width is based on its actual ink extent with padding rather than its potentially oversized empty horizontal region.

The canvas adds a screen-sized chunk of blank space as scrolling or ink approaches the bottom. The manual Add writing space action was removed. Vertical position is maintained in document coordinates while the fit scale changes.

All six native tests pass with the revised paper-layout contract covering temporary/narrow frames, portrait/landscape viewport sizes, automatic vertical extension and preservation of older ink outside the original nominal width. Simulator input verified downward scrolling into fresh blank paper; the signed physical-device build passed.

## Done-button freeze and purple controls

The reported freeze was reproduced after pressing Done on a scrolled canvas, even without edits to save. A main-thread sample located the block in `DrawingSurface.updateUIView`: assigning `isUserInteractionEnabled = false` on the first-responder PKCanvasView caused UIKit to resign focus and synchronously re-enter SwiftUI's responder/AttributeGraph update. The graph repeatedly reported a cycle and the app event loop stopped responding.

The representable no longer changes native interaction state during rendering. A transparent hit-testing overlay blocks canvas input while saving/loading. Native first-responder acquisition/release is deferred onto the main queue, outside SwiftUI attachment and teardown updates. The Done button and selected-tool tint use an explicit shared purple color rather than relying on Color.accentColor inheriting tint.

The end-to-end DrawingUITests regression draws through actual input, scrolls vertically, presses Done, verifies the embedded result, reopens it and presses Done without edits. On the old implementation it stalled immediately after the first Done tap and exceeded the test timeout; the stuck diagnostic collection was cancelled after capturing the failure. This exercises the UI responder lifecycle that the source-storage and UIKit layout tests cannot cover.

## Drawing interaction refinement

The custom toolbar previously inherited a disabled state whenever PencilKit began a stroke. That dimmed every control until the stroke ended, producing the reported blink. Stroke activity now gates hit testing without changing the toolbar's enabled appearance. Loading and publishing still disable controls, and the save/close operation independently rejects requests during an active stroke.

The first tap on an embedded drawing selects it in the note. A subsequent tap on the selected drawing opens the native editor; the pencil icon also opens it directly. Selection is captured before pointer-down changes it, so the first tap cannot be mistaken for a tap on an already-selected drawing. Drag, resize, long-press and cancelled gestures retain their existing handling. Pencil and Delete occupy a fixed action group in the image toolbar; the remaining controls scroll horizontally rather than wrapping Delete onto a separate row.

The UI regression now asserts that the first tap leaves the canvas closed, then reopens through the pencil action. It failed on the previous implementation because the canvas was already open, and passes with the selection fix. All six native drawing tests and five focused shared drawing/image tests passed; the web build, signed device build and style checks passed. Manual simulator inspection confirmed a single toolbar row with adjacent pencil/trash icons and reopening on a subsequent drawing tap. The resulting build was installed on the paired iPad Air.

Returning from native drawing editing now leaves the embed deselected. The host ends web text input and clears image node selection before presenting the canvas; this covers Done without edits and Close as well as publishing an edited drawing. The selection-only bridge command neither edits the note nor changes its scroll position or keyboard focus. Image-only documents use a gap cursor when no text caret is available. The extended UI test verifies Done, Close and selecting again on the first tap after return; all six native drawing tests and four focused shared drawing/image tests passed. A direct editor check also verified block-only and inline images deselect without changing their document content. The thickness popover now contains only the width slider and presets, with ink colors retained in the main toolbar. Web and signed device builds passed and the update was installed on the paired iPad Air.

## Daily-use settings, large snapshots and Mac compatibility

Tool, literal ink, stroke width and finger input persist through the existing app-scoped preferences, including isolated UI-test namespaces. Each drawing separately stores its scroll position and paper height locally. The viewport restores document coordinates after layout establishes the actual width, so a different window size does not change the writing location. Done, Close, backgrounding and completed scroll gestures checkpoint the viewport without changing drawing content.

The installed Mac application was built on November 6 and predated drawing support. A compatible local release bundle was built, locally signed and installed on November 8, retaining the previous app bundle as a backup. An isolated public-core-dispatch test transfers source and preview assets with their MIME types to a second database, edits surrounding text, returns the update, and verifies source bytes after restart. A separate desktop WebKit test consumes a Yjs drawing update, displays its preview, edits text, returns the update to the originating document, and reopens the desktop document with the source/preview pair intact. Neither check proves delivery through the user's signed-in cloud account; that live-device observation remains outstanding. At that stage Mac drawing editing was unavailable; the current native implementation is described below.

The SDK declares PKDrawing and PKStroke Sendable. The main actor now captures a drawing value and size; the draft actor handles native serialization, JSON encoding, geometry export and preview rendering. Loading also decodes source archives away from the main actor. No UIKit canvas view crosses that boundary. The existing color-rendering check still covers the snapshot renderer in light and dark appearance.

A file-boundary regression exposed a late autosave recreating a published checkpoint. Published revisions now suppress older/equal writes, while publication of an older revision cannot delete a newer checkpoint. Removing the published-revision guard made the regression fail with the stale draft present; restoring it passes. Unchanged drawings no longer create recovery drafts merely because the app backgrounds. Publication also respects the sync contract's 50 MB file limit, including the 29-byte encryption envelope, so an oversized source retains its local draft rather than publishing an asset that cannot upload.

A synthetic 5,000-stroke / 100,000-control-point workload passed checkpointing, draft recovery, managed publication and reopening in approximately 12 seconds total on the retained iPad simulator. This is an integrity/workload result, not a physical Pencil latency or frame-rate claim. Very long drawings still need the planned bounded pages, detailed previews and eventually a portable renderer; a single capped raster preview and one monolithic source are not a complete long-notebook design. Concurrent offline drawing revisions still require the revision graph described above.

With the correction, the same end-to-end UI test passed in 36.5 seconds and all six native DrawingTests passed. The signed physical-device build and project style lint passed.

## Native Mac editing and the live storage failure

Mac creation/editing now uses an AppKit mouse/trackpad canvas backed by the same PencilKit archive as iPad. A private Swift library embeds the canvas in the existing Mac note window; Rust exchanges private request/result files and publishes its source/PNG as managed assets. Mac insertion uses `/drawing`; iPad uses Note actions → Insert drawing. A selected embed's pencil action opens its editor. Tools include pen, pencil, marker, whole-stroke eraser, undo/redo and fixed colors/width. Close and Quit checkpoint locally; publication acknowledgements remove the draft. Observed stale source IDs retain the draft and offer Save a copy. This does not add stroke-level conflict merging or Windows/Linux editing.

`DrawingDocument` is shared Swift source rather than duplicated schemas. An offscreen native check invokes the real mouse handlers, undo/redo, eraser, local recovery and source/PNG publication. Its canvas-produced archive is read by an iPad simulator test, which verifies editable native control points and widths. Older iPad PencilKit readers can normalize Mac monoline to the pen family; the point data remains editable. PencilKit's replica manager needs a real bundle identifier, including in offscreen checks, so the main Mac application supplies the bundle identifier for the embedded library, and the check executable runs inside its own application bundle.

The user's physical-device alert was reproduced as an image-retention false positive. A complete Yjs update may introduce structs and delete some of them in the same payload. Checking delete ranges against the state before applying that payload incorrectly rejected valid history and blocked sync reconciliation. The check now uses the post-apply state; genuinely absent structs/deletions remain rejected. Known foreign asset IDs encoded in each valid version-1 payload also receive retention leases, including items hidden by that same payload, so the correction does not trade away live-undo safety. Separate regressions reproduced both the storage error and same-payload asset loss before their respective repairs. All 70 core unit tests and 8 dispatch tests pass.

Live read-only inspection found both devices on the same account and cursor. The iPad retained local modules whose shared vault tombstones marked them deleted; the storage failure prevented reconciliation from removing those stale rows. Before installing the fix, the complete iPad data directory was copied locally. The latest published drawing and its referenced images were imported with fresh asset IDs into a new live Mac note, Recovered Test module. The original backup remains intact. Reconciliation succeeds on a separate copy of the actual iPad database after the guard correction.

Full live delivery is still not asserted: a second Mac development app is using the same production database, and the recovered note's metadata is still pending in the Mac outbox. Mac UI automation currently returns `cgWindowNotFound` even for Finder, preventing the final on-screen check and safe normal quit of the other copy. The user has been asked to reopen the iPad app and make the Mac window visible. Once that external state is available, verify only the updated installed Mac app is syncing, then confirm the recovered note/source pair reaches the physical iPad before calling the live round trip complete.


## Mac canvas presentation update (November 9)

Mac editing now uses a Swift native library loaded by the main Tauri app. An
NSHostingView containing the canvas covers the note in its existing NSWindow;
Done and Close remove the canvas and restore the note. The window delegate
stays with Tauri, native undo/redo follows the canvas while open, and safe exit
checkpoints the local draft before waiting for the shared note save. This
replaces the separate drawing helper app, whose foreground activation left a
running editor inaccessible behind the note. Draft and publication formats are
unchanged. The native check now covers the actual presentation entry point,
note visibility, delegate preservation, Close, draft reopening, and Done.


## Preview appearance and asset arrival (November 9)

The Mac canvas and PNG exporter now render PencilKit under an explicit Aqua
appearance. SwiftUI's light color scheme alone did not prevent AppKit's drawing
renderer from adapting black ink to the surrounding dark application.

Drawing previews retain their previous decoded image while an immutable new
preview is missing, with an Updating drawing status until the replacement
loads. A WebKit node-view test exercises the reference change, pending resolver,
retained preview, and spinner dismissal after replacement decode.

Native iPad file sync previously classified an asset-upload race (HTTP 404)
as a transfer error with a 30-second retry. Its first retry now starts at two
seconds and increases to a 30-second cap for persistently unavailable assets;
other errors keep their existing retry policy. Desktop uses the same initial
retry and cap. The existing native file-transfer regression fails against the
old delay (approximately 30,000ms versus a 2,000ms deadline) and passes with the
new policy. This establishes retry behavior, not an end-to-end latency promise.
