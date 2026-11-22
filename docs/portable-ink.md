# Portable drawing source contract

Drawing embeds still reference an immutable JSON source and PNG preview using the
existing version-1 reference schema. Sync, backup, and Yjs store these assets
without interpreting the source's portable geometry.

`DrawingDocument.version == 1` makes the PencilKit archive authoritative. Updated
Apple publishers include `portable.version == 2` descriptors for every native
stroke. Each `kind: "native"` descriptor has a `nativeIndex` into that exact
archive, sampled curve points, brush name, RGB color, color alpha, affine
transform, and optional mask commands with their fill rule. Native points include
nib width, height, azimuth, opacity, and force normalized as pressure.

Windows and Linux save `DrawingDocument.version == 2`. The ordered portable stroke
list then controls selection and ordering. For each indexed record, Apple
reuses the archived brush, control points, and random seed and applies the
record's transform, mask, and fill rule. The sampled points, color, and brush
name describe the web preview. Web tools leave those fields intact. Apple
constructs new rounded strokes from web pen, marker, and pencil samples. Pencil samples import as
PencilKit pencil ink and export with the tool name `"pencil"`. Missing archives, invalid indices, and
invalid descriptors fail import without falling back to the whole archive.
Removing an indexed descriptor therefore cannot restore erased ink on Apple.
Apple publication creates a new archive and assigns fresh contiguous indices to
all remaining strokes, including strokes added on the web.

The optional top-level `paperStyle` is `"blank"`, `"lined"`, or `"grid"`. Apple
editors use their existing paper preference when the field is missing or unknown.
Apple drafts and published sources always include the current drawing's style,
and the preview renders its ruling.

Portable rendering approximates native brush texture and nib opacity. Canvas2D
transforms the stroke-local mask commands and sampled elliptical nibs together. Hit testing clips in
drawing coordinates, then uses the inverse stroke transform. Whole-stroke erase
and undo preserve all unselected descriptors and the archive. Lasso translation
moves the transform and any pixel cuts together. The stroke-local mask follows
the transform.

An optional native-only `cuts` array stores pixel erasures. Each entry is one
closed path using the same commands as a mask and represents the swept eraser
disk between two pointer samples. Each cut uses the even-odd fill rule and
subtracts its filled area from the original clip, or from the whole stroke
when there is no mask. Overlapping cuts leave their entire shared area erased.
A missing `cuts` field means there are no pixel cuts. Canvas clips out the
stored paths in drawing coordinates. Apple maps them back into stroke-local
coordinates and subtracts them into the reconstructed PencilKit mask.
Apple saves that resulting mask in its next archive and descriptors.

Sources without portable descriptors remain protected on Windows and Linux.
Reopening and publishing them on an updated Apple device supplies descriptors;
preview images and legacy spline control points are never converted into ink.
Older Apple builds reject version-2 portable sources rather than silently using
the archived pre-edit drawing. Native version-1 sources remain readable there.

Limits are 20,000 strokes, 500,000 sampled points, 500,000 mask and cut commands combined, a 64 MiB
native archive, page width 100,000, and page height 1,000,000. Point and mask
coordinates allow negative values within ±1,000,000. Native nib dimensions are
at most 1,000. Descriptors outside these bounds remain Apple-only; native archives
are retained. Existing publication byte limits also apply. The web backing canvas
is downsampled to about four million pixels, at most 4,096 by 16,384; saved source
coordinates and page dimensions keep their original precision. Long pages can
therefore have lower-resolution portable previews.

The browser fixture `native-descriptors.json` uses a placeholder archive to test
opaque retention. The Mac drawing harness constructs real PencilKit masked,
pencil, elliptical, translucent strokes and verifies indexed selection, reorder,
web append, re-export, and invalid-basis rejection. It also sends real Swift JSON through the TypeScript editor operations and verifies the moved and pixel-erased native result. iOS drawing tests also verify
masked native return.
