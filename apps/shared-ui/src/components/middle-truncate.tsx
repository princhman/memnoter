import { useLayoutEffect, useRef, useState } from "react";

/** Preserve both ends of a name as its available width changes. */
export function MiddleTruncate({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(text);
  useLayoutEffect(() => {
    const element = ref.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!element || !context) return;
    let active = true;
    const fit = () => {
      if (!active) return;
      context.font = getComputedStyle(element).font;
      const width = element.clientWidth;
      const chars = Array.from(text);
      const candidate = (count: number) => chars.slice(0, Math.ceil(count / 2)).join("") + "…" + chars.slice(chars.length - Math.floor(count / 2)).join("");
      if (context.measureText(text).width <= width) { setVisible(text); return; }
      let low = 0;
      let high = Math.max(0, chars.length - 1);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (context.measureText(candidate(mid)).width <= width) low = mid;
        else high = mid - 1;
      }
      setVisible(candidate(low));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    void document.fonts.ready.then(fit);
    return () => { active = false; observer.disconnect(); };
  }, [text]);
  // The hidden full name keeps the box as wide as the space allows, so it
  // grows back when the window widens instead of hugging the shortened text.
  return (
    <span ref={ref} title={text} aria-label={text} className="block min-w-0 max-w-full overflow-hidden whitespace-nowrap">
      <span aria-hidden className="invisible block h-0">{text}</span>
      {visible}
    </span>
  );
}
