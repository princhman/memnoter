// Executed in WebKit: canvas resolves wide-gamut/OKLCH CSS to sRGB before WCAG math.
export function measureContrast(selector = '#audit') {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = value => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    const p = ctx.getImageData(0, 0, 1, 1).data;
    return [p[0], p[1], p[2], p[3] / 255];
  };
  const over = (a, b) => {
    const alpha = a[3] + b[3] * (1 - a[3]);
    return [...a.slice(0, 3).map((v, i) => alpha ? (v * a[3] + b[i] * b[3] * (1 - a[3])) / alpha : 0), alpha];
  };
  const lum = c => c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  const results = [];
  function record(el, label, color, minimum, pseudo) {
    let fg = rgba(color), bg = [0, 0, 0, 0];
    // Flatten each ancestor group with its opacity, then composite on the canvas.
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      let fill = rgba(s.backgroundColor);
      // Table selection is a translucent pseudo-element painted ABOVE the ink.
      // Ordinary ancestor backgrounds alone would overestimate its contrast.
      if (node.matches('.selectedCell')) {
        const overlay = rgba(getComputedStyle(node, '::after').backgroundColor);
        if (Number(getComputedStyle(node, '::after').zIndex) < 0) fill = over(overlay, fill);
        else { fg = over(overlay, fg); bg = over(overlay, bg); }
      }
      fg = over(fg, fill); bg = over(bg, fill);
      fg[3] *= Number(s.opacity); bg[3] *= Number(s.opacity);
    }
    fg = over(fg, [255, 255, 255, 1]); bg = over(bg, [255, 255, 255, 1]);
    results.push({ label, pseudo, ratio: ratio(fg, bg), minimum, foreground: fg.slice(0, 3).map(Math.round), background: bg.slice(0, 3).map(Math.round) });
  }
  const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, el = node.parentElement, s = getComputedStyle(el);
    if (!node.textContent.trim() || !el.getClientRects().length || s.visibility !== 'visible' || parseFloat(s.fontSize) === 0) continue;
    // Inactive controls are explicitly exempt under WCAG 1.4.3; no live text is exempt.
    if (el.closest(':disabled,[aria-disabled="true"],[data-disabled]')) continue;
    const size = parseFloat(s.fontSize);
    record(el, el.closest('[data-audit]')?.dataset.audit ?? el.className, s.color, size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5);
  }
  for (const el of document.querySelectorAll('[data-audit-placeholder]')) record(el, el.dataset.auditPlaceholder, getComputedStyle(el, '::placeholder').color, 4.5, 'placeholder');
  for (const el of document.querySelectorAll('[data-audit-nontext]')) {
    const property = el.dataset.auditNontext;
    record(el.parentElement, el.dataset.audit, getComputedStyle(el)[property], 3, property);
  }
  return results;
}
