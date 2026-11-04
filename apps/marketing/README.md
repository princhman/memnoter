# memnoter.com

The standalone marketing site. The desktop app stays in `apps/shared-ui/` and `apps/desktop/`;
this folder has no runtime dependencies and does not participate in the app build.
It uses the approved assets in `../../brand/` without maintaining another master.

## Build and preview

From the repository root, with Node 22+ and internet access:

```sh
node apps/marketing/build.mjs
cd apps/marketing
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:4173. Rebuild after editing source files.

The build resolves the latest published GitHub release and matches the macOS
Apple silicon DMG, macOS Intel DMG, Windows x64 EXE, and Linux x64 AppImage.
It embeds direct installer URLs in the HTML, so downloads also work without
JavaScript. The build fails if GitHub is unavailable or a required installer is
missing. Existing deployed downloads stay working. Rebuild the site after a new
release to update the links and displayed version. Other formats link to GitHub.

## Hosting

Cloudflare Workers static assets (`wrangler.jsonc`), serving `memnoter.com`
and `www.memnoter.com`. To deploy by hand:

```sh
node apps/marketing/build.mjs
cd apps/marketing && npx wrangler@4 deploy
```

## Editing

- `index.html`: copy, layout, metadata, and direct download links.
- `styles.css`: responsive styles and reduced-motion support.
- `build.mjs`: asset packaging and verified release links.

The page works without JavaScript. It uses the approved brand mark as its hero visual.
Branding and font license are copied into the output at build time.
