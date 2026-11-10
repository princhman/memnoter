// Serves the static site, but keeps download links on the newest GitHub release
// without a redeploy. The build bakes in the release current at build time;
// this Worker swaps in a newer tag when one exists and falls back to the baked
// page if GitHub cannot be reached.
const REPO = 'https://github.com/princhman/memnoter';
const TAG = /^v\d+\.\d+\.\d+$/;
const ASSET = /\/releases\/download\/v(\d+\.\d+\.\d+)\/Memnoter_\1_/;

async function latestTag() {
  // The releases/latest page redirects to the tag; unlike the REST API it has
  // no per-IP rate limit that shared Cloudflare egress addresses would hit.
  const response = await fetch(`${REPO}/releases/latest`, {
    redirect: 'manual',
    cf: { cacheTtl: 300, cacheEverything: true },
    signal: AbortSignal.timeout(3000),
  });
  const tag = response.headers.get('location')?.split('/releases/tag/')[1];
  return tag && TAG.test(tag) ? tag : null;
}

export default {
  async fetch(request, env) {
    const page = await env.ASSETS.fetch(request);
    const type = page.headers.get('content-type') ?? '';
    if (!page.ok || !type.includes('text/html')) return page;
    let tag = null;
    try { tag = await latestTag(); } catch {}
    if (!tag) return page;
    const version = tag.slice(1);
    const rewritten = new HTMLRewriter()
      .on('a[href*="/releases/download/"]', {
        element(link) {
          const href = link.getAttribute('href');
          const match = href.match(ASSET);
          if (match) link.setAttribute('href', href.replace(ASSET, `/releases/download/${tag}/Memnoter_${version}_`));
        },
      })
      .on('[data-version]', { element(node) { node.setInnerContent(version); } })
      .transform(page);
    const response = new Response(rewritten.body, rewritten);
    response.headers.set('cache-control', 'public, max-age=300');
    return response;
  },
};
