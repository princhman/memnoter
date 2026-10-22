# Memnoter — consistent Paper Mark assets

Every current asset is built programmatically from `icon-white.png`. The master is unchanged, with its SHA-256 recorded in `manifest.json`. No independent image generation is used for these exports.

- `icon-white.png`: original approved master, 1254 × 1254.
- `icon-purple.png`: same geometry and placement; indigo ink becomes white, lavender stays lavender, background becomes purple.
- `icon-transparent.png` / `icon-reversed-transparent.png`: extracted original and reversed marks, with matching alpha masks.
- `logo-stacked-{white,purple,transparent}.{png,svg}`: name below mark.
- `logo-horizontal-{white,purple,transparent}.{png,svg}`: name right of mark.
- `icon-purple-{16,32,48,64,128,256,512,1024}.png`: square icon exports.
- `favicon.ico`: multiple sizes in one file.
- `preview.jpg`: overview assembled from the actual assets.

Typography: **DM Sans, weight 650**, from the project's existing font package. The generated concept did not identify a real font; these wordmarks use the actual DM Sans font consistently. The instantiated font and its license are included. Purple `#432fc8` is sampled from the master.

SVG wordmarks contain embedded raster icons and outlined text. They need no installed font, but the icon itself remains raster, not a vector trace. PNGs retain the original raster texture. Transparency is extracted by removing the white matte and recovering edge colours; the mark has not been redrawn.

Regenerate from the repository root using `python scripts/generate-brand-assets.py` with Pillow, numpy, fonttools and brotli installed. Project dependencies supply the source DM Sans WOFF2 font. `manifest.json` lists the current deliverables. The script is also included in the ZIP.

Obsolete concepts, independently generated variants and draft exports have been removed. This directory contains only the current asset set and its supporting files. No application icons or configuration have been changed.
