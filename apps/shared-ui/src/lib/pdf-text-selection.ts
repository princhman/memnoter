import type { PdfTextQuotePart } from "./pending-pdf-quote";

/** Read rendered text only: canvas pixels, source controls and reader chrome never enter a quote. */
export function readPdfTextSelection(reader: HTMLElement, source: { id: string; name: string }) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const layerFor = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(".textLayer");
  const start = layerFor(range.startContainer), end = layerFor(range.endContainer);
  if (!start || !end || !reader.contains(start) || !reader.contains(end)) return null;
  const parts: PdfTextQuotePart[] = [];
  let anchor: DOMRect | undefined;
  for (const page of reader.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
    const layer = page.querySelector(".textLayer");
    if (!range.intersectsNode(page)) continue;
    if (!layer) return null;
    if (!range.intersectsNode(layer)) continue;
    const bounds = page.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let text = "";
    const rectangles: DOMRect[] = [];
    let previous: DOMRect | undefined;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!range.intersectsNode(node)) continue;
      if (node instanceof HTMLBRElement) { if (text) text += "\n"; continue; }
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent) continue;
      const slice = document.createRange();
      slice.selectNodeContents(node);
      if (range.compareBoundaryPoints(Range.START_TO_START, slice) > 0) slice.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, slice) < 0) slice.setEnd(range.endContainer, range.endOffset);
      const value = slice.toString();
      if (!value) continue;
      const rects = Array.from(slice.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      const first = rects[0];
      if (first && previous && text && !/\s$/.test(text) && !/^\s/.test(value)) {
        // Some PDF producers omit EOL hints. Preserve visible line boundaries and word gaps.
        if (Math.abs(first.top - previous.top) > Math.min(first.height, previous.height) * .5) text += "\n";
        else if (first.left - previous.right > Math.min(first.height, previous.height) * .15) text += " ";
      }
      text += value;
      rectangles.push(...rects);
      previous = rects[rects.length - 1] ?? previous;
    }
    text = text.trim();
    if (!text || !rectangles.length) continue;
    const left = Math.max(bounds.left, Math.min(...rectangles.map(rect => rect.left)));
    const top = Math.max(bounds.top, Math.min(...rectangles.map(rect => rect.top)));
    const right = Math.min(bounds.right, Math.max(...rectangles.map(rect => rect.right)));
    const bottom = Math.min(bounds.bottom, Math.max(...rectangles.map(rect => rect.bottom)));
    if (right <= left || bottom <= top) return null;
    const x = (left - bounds.left) / bounds.width, y = (top - bounds.top) / bounds.height;
    parts.push({ text, source: { documentId: source.id, name: source.name, page: Number(page.dataset.pdfPage),
      region: { x, y, width: Math.min(1 - x, (right - left) / bounds.width), height: Math.min(1 - y, (bottom - top) / bounds.height) } } });
    anchor ??= rectangles[0];
  }
  return parts.length && anchor ? { parts, anchor } : null;
}
