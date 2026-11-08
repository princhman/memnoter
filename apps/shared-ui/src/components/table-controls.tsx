import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TableMap } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/react";
import { Plus } from "lucide-react";
import { TableBubbleActions } from "@/components/table-bubble-actions";
import { IconTooltip } from "@/components/icon-tooltip";

type Placement = { table: HTMLTableElement; left: number; top: number; right: number; bottom: number; caret: boolean };

// Lives outside contenteditable: these controls never enter copied HTML or Yjs.
export function TableControls({ editor }: { editor: Editor }) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = editor.view.dom;
    let hovered: HTMLTableElement | null = null;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (editor.isDestroyed) return;
      const { selection } = editor.state;
      let active: HTMLTableElement | null = null;
      for (let depth = selection.$from.depth; depth > 0; depth--) {
        if (selection.$from.node(depth).type.name === "table") {
          const dom = editor.view.nodeDOM(selection.$from.before(depth));
          if (dom instanceof HTMLElement) active = dom.matches("table") ? dom as HTMLTableElement : dom.querySelector("table");
          break;
        }
      }
      const focused = editor.view.hasFocus() || !!overlay.current?.contains(document.activeElement);
      const table = hovered?.isConnected ? hovered : focused ? active : null;
      if (!editor.isEditable || !table || !table.getClientRects().length) { setPlacement(null); return; }
      const rect = table.getBoundingClientRect();
      const wrapper = table.closest(".tableWrapper")?.getBoundingClientRect() ?? rect;
      const left = Math.max(rect.left, wrapper.left, 8);
      const right = Math.min(rect.right, wrapper.right, window.innerWidth - 24);
      // Also respect vertical scrolling containers (the note pane on desktop).
      let clipTop = 0, clipBottom = window.innerHeight;
      for (let parent = table.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();
          clipTop = Math.max(clipTop, bounds.top); clipBottom = Math.min(clipBottom, bounds.bottom);
        }
      }
      if (rect.bottom < clipTop || rect.top > clipBottom || right <= left) { setPlacement(null); return; }
      setPlacement({ table, left, right, top: Math.max(rect.top, clipTop), bottom: Math.min(rect.bottom, clipBottom), caret: focused && table === active && selection.empty });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const over = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (overlay.current?.contains(target)) return;
      hovered = root.contains(target) ? target.closest("table") : null;
      schedule();
    };
    const leave = () => { hovered = null; schedule(); };
    editor.on("transaction", schedule).on("focus", schedule).on("blur", schedule);
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerleave", leave);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      editor.off("transaction", schedule).off("focus", schedule).off("blur", schedule);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerleave", leave);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [editor]);

  if (!placement) return null;
  const { table, left, right, top, bottom, caret } = placement;
  const append = (column: boolean) => {
    const pos = editor.view.posAtDOM(table, 0);
    const $pos = editor.state.doc.resolve(pos);
    const depth = $pos.node().type.name === "table" ? $pos.depth : $pos.depth + 1;
    const node = $pos.node(depth);
    // TableMap handles merged cells and cells containing only block images.
    const map = TableMap.get(node);
    const lastCell = $pos.start(depth) + map.map[map.map.length - 1];
    editor.chain().focus().setCellSelection({ anchorCell: lastCell })[column ? "addColumnAfter" : "addRowAfter"]().run();
  };
  return createPortal(<div ref={overlay} data-table-controls onMouseDown={event => event.preventDefault()}>
    <IconTooltip label="Add column">
      <button type="button" className="table-edge table-edge-column bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground" aria-label="Add column" style={{ left: right, top, height: bottom - top }} onClick={() => append(true)}><Plus size={14} /></button>
    </IconTooltip>
    <IconTooltip label="Add row" hint="Tab in the last cell also adds a row">
      <button type="button" className="table-edge table-edge-row bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground" aria-label="Add row" style={{ left, top: bottom, width: right - left }} onClick={() => append(false)}><Plus size={14} /></button>
    </IconTooltip>
    {caret && <div role="toolbar" aria-label="Table actions" className="table-caret-toolbar floating-surface bg-popover text-popover-foreground shadow-md" style={{ left: Math.max(8, Math.min(left, window.innerWidth - 320)), top: top >= 44 ? top - 42 : bottom + 20 }}>
      <TableBubbleActions editor={editor} />
    </div>}
  </div>, document.body);
}
