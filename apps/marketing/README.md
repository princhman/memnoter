# memnoter.com

The standalone marketing site. The desktop app stays in `apps/shared-ui/` and `apps/desktop/`;
this folder has no runtime dependencies and does not participate in the app build.
It uses the approved assets in `../../brand/` without maintaining another master.

## Build and preview

From the repository root, with Node 22+ and internet access:

```sh
node apps/marketing/build.mjs
pnpm --dir apps/marketing preview
```

The preview uses Wrangler from the workspace's sync package. If needed, install
it with `pnpm install --filter memnoter-sync`. Open http://127.0.0.1:4173 to
check the site, including `/support` and `/privacy`. Rebuild after editing source
files.

The build resolves the latest published GitHub release and matches the macOS
Apple silicon DMG, macOS Intel DMG, Windows x64 EXE, and Linux x64 AppImage.
It embeds direct installer URLs in the HTML, so downloads also work without
JavaScript. The build fails if GitHub is unavailable or a required installer is
missing. Other formats link to GitHub.

`worker.js` keeps the page on the newest release without a redeploy: for HTML
requests it reads the tag that `releases/latest` redirects to (cached for five
minutes) and rewrites the installer links and displayed version. If GitHub is
unreachable it serves the links baked in at build time. It assumes installer
names keep the `Memnoter_<version>_` prefix, which the build checks.

## Hosting

Cloudflare Workers static assets plus `worker.js` (`wrangler.jsonc`), serving `memnoter.com`
and `www.memnoter.com`. Cloudflare deploys it from `main` through the
dashboard's Git integration; never deploy it by hand.

## Editing

- `index.html`: copy, layout, metadata, and direct download links.
- `demo.js`: the homepage card, cloze and review demo. The page still reads without it.
- `support.html`: the support page at `/support`, also the App Store support URL.
- `privacy.html`: the privacy policy at `/privacy`, also the App Store privacy policy URL. This is the published policy, not a draft.
- `terms.html`: draft terms at `/terms`, marked for review and hidden from search engines (`noindex`, not in the sitemap) until approved.
- `styles.css`: responsive styles and reduced-motion support.
- `screenshots/`: cropped product frames, light and dark, in AVIF and WebP. The TanStack dev badge is painted out. Review was only captured in light, so that frame stays on the light shot.
- `build.mjs`: asset packaging and verified release links.
- `worker.js`: keeps download links on the latest release between deploys.

The frames are crops, not full windows: `hero` pans a note, `cards` and `occlusion` alternate, `review-card` and `review-grades` alternate, and `pdf`, `bank`, and `worksheet` play in that order. `maths` is the formula. Each has `-light` and `-dark` except the review pair, plus a `-720` width where the crop is wider than 720. `og.png` is the link preview.

There is no public TestFlight URL in the repo. The iOS control is a disabled placeholder until that URL is pasted into `index.html`.

The page works without JavaScript. Sequences stay on their first frame, and the hero pan is CSS, so it still moves unless the visitor prefers reduced motion.
Branding and font license are copied into the output at build time.
