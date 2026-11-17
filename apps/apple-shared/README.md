# Drawing sources

Notes and worksheet answers reference immutable source/PNG asset pairs through
existing version-1 drawing references. Asset IDs, rather than local paths, carry
both files through file sync and backups. A PNG alone is not an editable drawing.
Unsynced local drafts are recovery checkpoints, cleared after the owning note or
answer acknowledges its durable reference save.

`DrawingDocument` version 1 uses `nativeData` (base64 PencilKit archive) as its
authority. Its optional `geometry` is the existing inspection export of PencilKit
spline control points, transforms and masks; it must never be interpreted as web
pointer samples. New native publications also include `portable` when every
stroke is supported. Older sources need an updated Apple app to republish them.

Version 2 uses `portable` as its authority. `nativeData` and `geometry` retain the
previous native archive and inspection sidecar when available, but readers must
not use them to replace portable edits. Older Apple builds reject version 2 via
their version validation. Updated Apple readers reconstruct editable PencilKit
strokes from portable ink, then export subsequent supported native edits again.
Native publication returns to version 1 with a fresh authoritative archive.

Portable ink has `version: 1` and `strokes`. Each stroke contains `tool` (`pen` or
`marker`), a six-digit `#rrggbb` color, `width` in page points, and a nonempty
`points` array of `{x, y, pressure}`. Coordinates use the document's top-left page
space. Pressure is 0–1; round nib diameter is `width * (0.25 + 0.75 * pressure)`.
Marker composites each entire stroke at 0.35 opacity. Erase removes whole strokes.
PencilKit reconstructs a spline from these samples; brush rendering and smoothing
are approximate, not lossless or latency-equivalent to PencilKit.

Native export samples on-curve interpolated points, not control points. It only
exports unmasked, untransformed round pen/monoline/marker ink with supported
opacity and bounds. Partial erase masks, pencil textures, transformed or other
unsupported ink keep the native archive and preview but omit portable geometry.
Windows/Linux refuse to edit such a document and explain the limitation. They
never flatten its preview, drop unsupported strokes, or resurrect masked ink.

The portable editor limits paper allocation, stroke/sample counts and numeric
ranges. Browser input uses Pointer Events with capture, optional coalesced events,
pressure, cancellation rollback and one active pointer. Touch ink is opt-in;
large contacts and secondary touches are rejected. Hardware palm rejection varies.

The shared `apps/ios/Tests/Fixtures/portable-drawing.json` intentionally contains
an invalid native sidecar: the Apple adapter test must reconstruct portable ink,
then publish additional native strokes without reading that stale sidecar.
Run `DrawingTests` on an Apple SDK host; Linux cannot execute PencilKit tests.
