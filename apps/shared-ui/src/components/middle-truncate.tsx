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
      // scrollWidth is the full name's laid-out width (from the ::after copy),
      // rounded like clientWidth, so a name that fits is never cut.
      const width = element.clientWidth;
      const full = element.scrollWidth;
      if (full <= width) { setVisible(text); return; }
      context.font = getComputedStyle(element).font;
      // Canvas ignores letter spacing and font features; scale to the layout.
      const scale = full / (context.measureText(text).width || full);
      // Whole graphemes, so a cut never splits an emoji or an accent from its letter.
      const chars = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), part => part.segment);
      const candidate = (count: number) => chars.slice(0, Math.ceil(count / 2)).join("") + "…" + chars.slice(chars.length - Math.floor(count / 2)).join("");
      let low = 0;
      let high = Math.max(0, chars.length - 1);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (context.measureText(candidate(mid)).width * scale <= width) low = mid;
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
  // The invisible ::after copy keeps the box as wide as the space allows, so it
  // grows back when the window widens instead of hugging the shortened text.
  return (
    <span
      ref={ref}
      title={text}
      aria-label={text}
      data-full={text}
      className="block min-w-0 max-w-full overflow-hidden whitespace-nowrap after:invisible after:block after:h-0 after:content-[attr(data-full)]"
    >
      {visible}
    </span>
  );
}
