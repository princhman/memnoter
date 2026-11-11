// Vite's CSS imports need these helpers even with server.hmr=false. Its real
// client also opens a socket and can reload on reconnect, bypassing our save
// barrier. Device mode serves this CSS-only implementation at /@vite/client.
const styles = new Map();
export function updateStyle(id, content) {
  let style = styles.get(id);
  if (!style) {
    style = document.createElement('style');
    style.dataset.viteDevId = id;
    document.head.append(style);
    styles.set(id, style);
  }
  style.textContent = content;
}
export function removeStyle(id) { styles.get(id)?.remove(); styles.delete(id); }
export function createHotContext() {
  return { data: {}, accept() {}, acceptExports() {}, prune() {}, dispose() {}, on() {}, off() {}, send() {}, invalidate() {} };
}
export function injectQuery(url, query) {
  const [path, hash] = url.split('#');
  return `${path}${path.includes('?') ? '&' : '?'}${query}${hash === undefined ? '' : `#${hash}`}`;
}
