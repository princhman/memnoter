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
list then controls selection and ordering. Apple import copies each selected
original PKStroke from the immutable archive. It constructs native strokes only
for new round web pen and marker samples. Missing archives, invalid indices, and
invalid descriptors fail import without falling back to the whole archive.
Removing an indexed descriptor therefore cannot restore erased ink on Apple.
Apple publication creates a new archive and assigns fresh contiguous indices to
all remaining strokes, including strokes added on the web.

Portable rendering approximates native brush texture and nib opacity. Canvas2D
applies the exported affine transform and exact quadratic, cubic, line, and close
mask commands before drawing sampled elliptical nibs. Hit testing uses the inverse
transform and the mask's fill rule. Whole-stroke erase and undo preserve all
unselected descriptors and the archive. Native return retains original masks,
texture, transforms, and opacity through the archived PKStroke, independent of
portable rendering quality. Imported colors are preserved without rewriting
white native ink as black.

Sources without portable descriptors remain protected on Windows and Linux.
Reopening and publishing them on an updated Apple device supplies descriptors;
preview images and legacy spline control points are never converted into ink.
Older Apple builds reject version-2 portable sources rather than silently using
the archived pre-edit drawing. Native version-1 sources remain readable there.

Limits are 20,000 strokes, 500,000 sampled points, 500,000 mask commands, a 64 MiB
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
web append, re-export, and invalid-basis rejection. iOS drawing tests also verify
masked native return.
