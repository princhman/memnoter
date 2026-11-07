import { isNativeHost } from "@/lib/backend";
import { headingNumbers } from "@/lib/heading-numbering";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Editor } from "@tiptap/core";
import type {
  TableOfContentData,
  TableOfContentDataItem,
} from "@tiptap/extension-table-of-contents";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { createStore, useSelector } from "@tanstack/react-store";
import katex from "katex";
import { ChevronRight } from "lucide-react";
import { getFocusedSectionRange } from "@/lib/section-focus";
import { getFoldedRanges } from "@/lib/heading-fold";

export type TocStore = ReturnType<typeof createTocStore>;

export function createTocStore() {
  return createStore<TableOfContentData>([]);
}

// Dash width in the rail, by nesting level.
const DASH_WIDTHS = [28, 20, 14, 9];
// Keeps the popup this far from the window edges.
const VIEWPORT_MARGIN = 16;
// Keep short notes fully expanded; longer outlines start with two relative levels.
const LONG_OUTLINE_THRESHOLD = 40;
const BRANCH_HOVER_DELAY = 180;

type HoveredSection = {
  start: number;
  // Centre of the hovered dash, relative to the nav.
  anchor: number;
};

// Headings keep inline math as raw LaTeX, so render it like the editor does.
function HeadingTitle({ node }: { node: PMNode }) {
  const html = useMemo(() => {
    const parts: string[] = [];
    node.forEach((child) => {
      if (child.type.name === "inlineMath") {
        parts.push(
          katex.renderToString(child.textContent.replace(/\u200b/g, ""), {
            throwOnError: false,
            displayMode: false,
          }),
        );
      } else if (child.isText) {
        const span = document.createElement("span");
        span.textContent = child.text ?? "";
        parts.push(span.innerHTML);
      }
    });
    return parts.join("");
  }, [node]);

  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function DesktopTableOfContents({
  editor,
  store,
  numbered = false,
}: {
  editor: Editor | null;
  store: TocStore;
  numbered?: boolean;
}) {
  const numbers = useEditorState({ editor, selector: ({ editor }) => editor ? [...headingNumbers(editor.state.doc)] : [] });
  const numberMap = useMemo(() => new Map(numbers ?? []), [numbers]);
  const numberAt = (pos: number) => numbered ? `${numberMap.get(pos) ?? ""} ` : "";
  const allItems = useSelector(store, (state) => state);
  // Focus changes don't touch the document, so the TOC extension won't report them.
  const focusRange = useEditorState({
    editor,
    selector: ({ editor }) => {
      const range = editor ? getFocusedSectionRange(editor.state) : null;
      return range ? `${range.from}:${range.to}` : null;
    },
  });
  // Folding doesn't touch the document either. Serialised so equal folds compare equal.
  const foldedRanges = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor ? JSON.stringify(getFoldedRanges(editor.state)) : "[]",
  });
  const folded = useMemo(
    () =>
      JSON.parse(foldedRanges ?? "[]") as ReturnType<typeof getFoldedRanges>,
    [foldedRanges],
  );
  // Headings inside a folded section are hidden in the editor, so leave them out
  // here too; their folded heading is marked instead.
  const items = useMemo(() => {
    const [from, to] = focusRange?.split(":").map(Number) ?? [];
    return allItems.filter(
      (item) =>
        (!focusRange || (item.pos >= from && item.pos < to)) &&
        !folded.some((range) => item.pos >= range.from && item.pos < range.to),
    );
  }, [allItems, focusRange, folded]);
  const longOutline = items.length > LONG_OUTLINE_THRESHOLD;
  const shallowLevels = [...new Set(items.map(item => item.originalLevel))].sort((a, b) => a - b).slice(0, 2);
  const ancestors = new Map<string, string[]>();
  const stack: TableOfContentData = [];
  for (const item of items) {
    while (stack.length && stack[stack.length - 1].originalLevel >= item.originalLevel) stack.pop();
    ancestors.set(item.id, stack.filter(parent => shallowLevels.includes(parent.originalLevel)).map(parent => parent.id));
    stack.push(item);
  }
  // This list never changes in response to hover or the active heading.
  const visibleItems = items.filter(item => !longOutline || shallowLevels.includes(item.originalLevel) || !ancestors.get(item.id)?.length);
  const visibleIds = new Set(visibleItems.map(item => item.id));
  const activeId = [...items].reverse().find(item => item.isScrolledOver)?.id ?? items[0]?.id;
  const activeMainId = visibleIds.has(activeId) ? activeId : ancestors.get(activeId)?.slice(-1)[0];
  // A hidden heading belongs only to its nearest visible ancestor, so a root
  // never repeats the visible second-level rows or their own flyout contents.
  const hiddenDescendants = new Map<string, TableOfContentData>();
  for (const item of items) {
    if (visibleIds.has(item.id)) continue;
    const parent = ancestors.get(item.id)?.slice(-1)[0];
    if (!parent) continue;
    const children = hiddenDescendants.get(parent) ?? [];
    children.push(item);
    hiddenDescendants.set(parent, children);
  }
  const hasChildren = (item: TableOfContentDataItem) => hiddenDescendants.has(item.id);
  const isFolded = (item: TableOfContentDataItem) => folded.some(range => range.heading === item.pos);
  const [hovered, setHovered] = useState<HoveredSection | null>(null);
  const hoverNodes = useRef<HTMLElement[]>([]);
  const dashRefs = useRef(new Map<string, HTMLButtonElement>());
  const mainRowRefs = useRef(new Map<string, HTMLDivElement>());
  const flyoutRowRefs = useRef(new Map<string, HTMLDivElement>());
  const scrubRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const railMode = useRef<"idle" | "following" | "transit">("idle");
  const frameRef = useRef<number | null>(null);
  const settledBranch = useRef<string | null>(null);
  const flyoutIdRef = useRef<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [compact, setCompact] = useState(false);
  const [flyoutId, setFlyoutId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<string | null>(null);
  const flyoutDomId = useId();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTypeRef = useRef("");
  const navRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const safeAreaRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutSafeRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const enterFlyoutRef = useRef(false);
  const skipFocusOpenRef = useRef(false);
  const flyoutParent = items.find(item => item.id === flyoutId);
  const descendants = hiddenDescendants.get(flyoutId ?? "") ?? [];
  const flyoutBaseLevel = Math.min(...descendants.map(item => item.originalLevel));
  flyoutIdRef.current = flyoutId;

  useEffect(() => {
    closeOutline();
    if (!editor || editor.isDestroyed) return;
    editor.storage.tableOfContents.scrollHandler();
  }, [editor, focusRange, foldedRanges]);

  useEffect(() => {
    if (!pinned) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && navRef.current?.contains(event.target)) return;
      closeOutline();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [pinned]);

  useLayoutEffect(() => {
    if (!editor) return;
    const measure = () => {
      const nav = navRef.current;
      if (!nav) return;
      hideTooltip();
      setCompact(!window.matchMedia("(pointer: coarse)").matches &&
        nav.getBoundingClientRect().left - editor.view.dom.getBoundingClientRect().right < 240);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(editor.view.dom);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [editor, items.length]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    for (const timer of [hoverTimer, closeTimer, branchTimer, branchCloseTimer, tooltipTimer]) {
      if (timer.current) clearTimeout(timer.current);
    }
  }, []);

  function minTop() {
    const content = editor?.view.dom.closest(".app-scroll-container")?.getBoundingClientRect();
    return Math.max(VIEWPORT_MARGIN, (content?.top ?? 0) + VIEWPORT_MARGIN);
  }

  useLayoutEffect(() => {
    const position = () => {
      const nav = navRef.current;
      const panel = panelRef.current;
      if (!hovered || !nav || !panel) return;
      const navTop = nav.getBoundingClientRect().top;
      if (compact) {
        const row = parseFloat(getComputedStyle(panel).fontSize) * 1.75;
        const available = Math.min(window.innerHeight * 0.6, window.innerHeight - minTop() - VIEWPORT_MARGIN);
        const rows = Math.max(1, Math.floor((available - 16) / row));
        panel.style.height = `${Math.min(rows, visibleItems.length) * row + 16}px`;
      } else panel.style.removeProperty("height");
      const height = panel.offsetHeight;
      const top = Math.max(minTop(), Math.min(navTop + hovered.anchor - height / 2, window.innerHeight - VIEWPORT_MARGIN - height));
      panel.style.top = `${top - navTop}px`;
      const scrub = scrubRef.current;
      const current = panel.querySelector<HTMLElement>('[data-active="true"]');
      if (scrub) applyScrub(scrub);
      else if (current) panel.scrollTop = current.offsetTop - panel.clientHeight / 2 + current.offsetHeight / 2;
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [hovered, compact, editor, items]);

  useLayoutEffect(() => {
    const position = () => {
      const nav = navRef.current;
      const panel = panelRef.current;
      const flyout = flyoutRef.current;
      const row = panel?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(flyoutId ?? "")}"]`);
      if (!nav || !panel || !flyout || !row) return;
      const bounds = panel.getBoundingClientRect();
      const anchor = row.getBoundingClientRect();
      if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom) {
        if (railMode.current === "idle") closeFlyout();
        else flyout.style.visibility = "hidden";
        return;
      }
      flyout.style.visibility = "visible";
      const leftRoom = bounds.left - VIEWPORT_MARGIN - 8;
      const rightRoom = window.innerWidth - VIEWPORT_MARGIN - bounds.right - 8;
      const preferred = Math.min(320, window.innerWidth - VIEWPORT_MARGIN * 2);
      const side = leftRoom >= 180 ? "left" : rightRoom >= 180 ? "right" : "overlay";
      const width = side === "overlay" ? Math.min(preferred, bounds.width) : Math.min(preferred, side === "left" ? leftRoom : rightRoom);
      flyout.style.width = `${width}px`;
      const available = Math.min(window.innerHeight * 0.6, window.innerHeight - minTop() - VIEWPORT_MARGIN);
      const rowHeight = parseFloat(getComputedStyle(flyout).fontSize) * 1.75;
      flyout.style.maxHeight = `${Math.max(1, Math.floor((available - 16) / rowHeight)) * rowHeight + 16}px`;
      const height = flyout.offsetHeight;
      const top = Math.max(minTop(), Math.min(anchor.top - 8, window.innerHeight - VIEWPORT_MARGIN - height));
      const left = side === "left" ? bounds.left - width - 8 : side === "right" ? bounds.right + 8 : bounds.left;
      const navBounds = nav.getBoundingClientRect();
      flyout.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - VIEWPORT_MARGIN - width)) - navBounds.left}px`;
      flyout.style.top = `${top - navBounds.top}px`;
      flyout.dataset.side = side;
    };
    position();
    const flyout = flyoutRef.current;
    const current = flyout?.querySelector<HTMLElement>('[data-active="true"]');
    if (scrubRef.current) applyScrub(scrubRef.current);
    else if (current && flyout) flyout.scrollTop = current.offsetTop - flyout.clientHeight / 2 + current.offsetHeight / 2;
    if (enterFlyoutRef.current && flyout) {
      enterFlyoutRef.current = false;
      (current ?? flyout.querySelector<HTMLElement>(".toc-item"))?.focus({ preventScroll: true });
    }
    window.addEventListener("resize", position);
    const panel = panelRef.current;
    panel?.addEventListener("scroll", position);
    return () => { window.removeEventListener("resize", position); panel?.removeEventListener("scroll", position); };
  }, [flyoutId, items, compact, hovered]);

  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    const nav = navRef.current;
    const panel = panelRef.current;
    if (!tip || !nav || !panel) return;
    const bounds = panel.getBoundingClientRect();
    const flyout = flyoutRef.current?.getBoundingClientRect();
    const top = Math.min(bounds.top, flyout?.top ?? bounds.top);
    const bottom = Math.max(bounds.bottom, flyout?.bottom ?? bounds.bottom);
    const y = top - tip.offsetHeight - 8 >= VIEWPORT_MARGIN ? top - tip.offsetHeight - 8 : bottom + 8;
    if (y + tip.offsetHeight > window.innerHeight - VIEWPORT_MARGIN) { setTooltip(null); return; }
    const navBounds = nav.getBoundingClientRect();
    tip.style.top = `${y - navBounds.top}px`;
    tip.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(bounds.right - tip.offsetWidth, window.innerWidth - VIEWPORT_MARGIN - tip.offsetWidth)) - navBounds.left}px`;
  }, [tooltip, flyoutId]);

  function hideTooltip() {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    setTooltip(null);
  }

  function showTooltip(row: HTMLElement, title: string) {
    hideTooltip();
    const text = row.querySelector<HTMLElement>(".toc-item-title");
    if (text && text.scrollWidth > text.clientWidth + 1) {
      tooltipTimer.current = setTimeout(() => setTooltip(title), 450);
    }
  }

  function closeFlyout(restoreFocus = false) {
    enterFlyoutRef.current = false;
    if (branchTimer.current) clearTimeout(branchTimer.current);
    if (branchCloseTimer.current) clearTimeout(branchCloseTimer.current);
    setFlyoutId(null);
    hideTooltip();
    if (restoreFocus && returnFocusRef.current) {
      skipFocusOpenRef.current = true;
      returnFocusRef.current.focus({ preventScroll: true });
      skipFocusOpenRef.current = false;
    }
  }

  function openFlyout(item: TableOfContentDataItem, enter = false) {
    if (!hasChildren(item)) { closeFlyout(); return; }
    if (branchCloseTimer.current) clearTimeout(branchCloseTimer.current);
    const row = panelRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(item.id)}"]`);
    returnFocusRef.current = row?.querySelector<HTMLElement>(".toc-branch-trigger") ?? null;
    enterFlyoutRef.current = enter;
    if (flyoutId === item.id && enter) {
      enterFlyoutRef.current = false;
      (flyoutRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? flyoutRef.current?.querySelector<HTMLElement>(".toc-item"))?.focus({ preventScroll: true });
    }
    setFlyoutId(item.id);
  }

  function closeOutline() {
    stopRail();
    scrubRef.current = null;
    settledBranch.current = null;
    for (const timer of [hoverTimer, closeTimer]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    closeFlyout();
    setHovered(null);
    paintHover();
    setPinned(false);
  }

  function openSection(index: number, dash: HTMLElement) {
    setHovered({ start: index, anchor: dash.getBoundingClientRect().top - navRef.current!.getBoundingClientRect().top + dash.offsetHeight / 2 });
  }

  // Pointer frames only scroll and repaint the affected DOM nodes. React mounts
  // the panel once and switches a hidden heading's flyout after hover intent.
  function paintHover(mainId?: string, childId?: string, dashId?: string) {
    for (const node of hoverNodes.current) {
      node.dataset.hover = "false";
      node.dataset.related = "false";
    }
    const main = mainId ? mainRowRefs.current.get(mainId) : undefined;
    const child = childId ? flyoutRowRefs.current.get(childId) : undefined;
    const dash = dashId ? dashRefs.current.get(dashId) : undefined;
    if (main) main.dataset.hover = "true";
    if (child) child.dataset.hover = "true";
    if (dash) dash.dataset.related = "true";
    hoverNodes.current = [main, child, dash].filter((node): node is HTMLDivElement | HTMLButtonElement => !!node);
  }

  function alignRow(list: HTMLElement, row: HTMLElement, y: number) {
    const bounds = list.getBoundingClientRect();
    const centre = Math.max(bounds.top + 8 + row.offsetHeight / 2,
      Math.min(y, bounds.bottom - 8 - row.offsetHeight / 2));
    const height = row.getBoundingClientRect().height;
    const top = row.offsetTop - (centre - bounds.top) + row.offsetHeight / 2;
    // Keep complete rows at the surface edges while following within half a row.
    list.scrollTop = Math.round(top / height) * height;
  }

  function applyScrub(scrub: { id: string; x: number; y: number }) {
    const owner = visibleIds.has(scrub.id) ? scrub.id : ancestors.get(scrub.id)?.slice(-1)[0];
    const panel = panelRef.current;
    const row = owner ? mainRowRefs.current.get(owner) : undefined;
    if (panel && row) alignRow(panel, row, scrub.y);
    const child = flyoutRowRefs.current.get(scrub.id);
    if (owner === flyoutIdRef.current && flyoutRef.current && child) alignRow(flyoutRef.current, child, scrub.y);
    paintHover(owner, visibleIds.has(scrub.id) ? undefined : scrub.id, scrub.id);
    if (panel) updateSafeArea(scrub, panel, safeAreaRef.current);
    const branch = visibleIds.has(scrub.id) ? null : owner ?? null;
    if (settledBranch.current !== branch) {
      settledBranch.current = branch;
      if (branchTimer.current) clearTimeout(branchTimer.current);
      // Keep the current popup while crossing its descendants; switch only
      // after settling on a branch, without delaying the main list's scroll.
      branchTimer.current = setTimeout(() => {
        branchTimer.current = null;
        if (scrubRef.current && railMode.current !== "idle") {
          returnFocusRef.current = branch ? mainRowRefs.current.get(branch)?.querySelector<HTMLElement>(".toc-branch-trigger") ?? null : null;
          setFlyoutId(branch);
        }
      }, BRANCH_HOVER_DELAY);
    }
  }

  function stopRail() {
    railMode.current = "idle";
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (branchTimer.current) clearTimeout(branchTimer.current);
    if (safeAreaRef.current) safeAreaRef.current.style.width = "0px";
  }

  function freezeRail() {
    if (frameRef.current !== null && scrubRef.current) applyScrub(scrubRef.current);
    railMode.current = "transit";
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }

  function scrubRail(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch" || pinned) return;
    const previous = scrubRef.current;
    if (railMode.current === "following" && previous && event.clientX < previous.x - 0.5) {
      freezeRail();
      return;
    }
    // The safe triangle owns leftward travel. Re-entering from its right edge
    // resumes the scrubber, even when the pointer returns at another height.
    if (railMode.current === "transit" && previous && event.clientX < previous.x - 0.5) return;
    const dash = (event.target as Element).closest<HTMLButtonElement>(".toc-dash");
    const id = dash?.dataset.headingId;
    if (!id || !dash) return;
    if (railMode.current !== "following") settledBranch.current = flyoutIdRef.current;
    railMode.current = "following";
    scrubRef.current = { id, x: event.clientX, y: event.clientY };
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (!panelRef.current && !hoverTimer.current) {
      const index = Number(dash.dataset.index);
      if (compact) hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        openSection(index, dash);
      }, BRANCH_HOVER_DELAY);
      else openSection(index, dash);
    }
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (railMode.current === "following" && scrubRef.current) applyScrub(scrubRef.current);
    });
  }

  // A triangle catches diagonal pointer travel before intervening rows can open.
  function updateSafeArea(event: { clientX: number; clientY: number } | { x: number; y: number }, target: HTMLElement | null, area: HTMLElement | null) {
    const nav = navRef.current;
    if (!nav || !target || !area) return;
    const clientX = "clientX" in event ? event.clientX : event.x;
    const clientY = "clientY" in event ? event.clientY : event.y;
    const bounds = target.getBoundingClientRect();
    const navBounds = nav.getBoundingClientRect();
    const leftSide = clientX >= bounds.right;
    const edge = leftSide ? bounds.right : bounds.left;
    const apex = clientX + (leftSide ? -2 : 2);
    const left = Math.min(edge, apex);
    const top = Math.min(bounds.top, clientY);
    area.style.left = `${left - navBounds.left}px`;
    area.style.top = `${top - navBounds.top}px`;
    area.style.width = `${Math.abs(edge - apex)}px`;
    area.style.height = `${Math.max(bounds.bottom, clientY) - top}px`;
    area.style.clipPath = `polygon(${apex - left}px ${clientY - top}px, ${edge - left}px ${bounds.top - top}px, ${edge - left}px ${bounds.bottom - top}px)`;
  }

  function navigateList(event: React.KeyboardEvent<HTMLDivElement>) {
    const list = event.currentTarget;
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>(".toc-item"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const pageSize = Math.max(1, Math.floor(list.clientHeight / (buttons[0]?.offsetHeight || 28)) - 1);
    const target = event.key === "PageDown" ? Math.min(index + pageSize, buttons.length - 1)
      : event.key === "PageUp" ? Math.max(index - pageSize, 0)
      : event.key === "End" ? buttons.length - 1 : event.key === "Home" ? 0
      : event.key === "ArrowDown" ? Math.min(index + 1, buttons.length - 1)
      : event.key === "ArrowUp" ? Math.max(index - 1, 0) : null;
    if (target !== null) {
      event.preventDefault();
      const button = buttons[target];
      if (button) {
        list.scrollTop = button.offsetTop - 8;
        button.focus({ preventScroll: true });
      }
    }
  }

  function scrollTo(item: TableOfContentDataItem) {
    const heading = editor?.view.dom.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(item.id)}"]`) ?? item.dom;
    heading.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRow(item: TableOfContentDataItem, baseLevel: number, inFlyout = false) {
    const children = !inFlyout && hasChildren(item);
    const title = numberAt(item.pos) + item.textContent;
    return <div key={item.id} ref={node => {
      const rows = inFlyout ? flyoutRowRefs.current : mainRowRefs.current;
      if (node) rows.set(item.id, node); else rows.delete(item.id);
    }} className="toc-row" data-entry-id={item.id} data-hover="false"
      onPointerEnter={(event) => {
        stopRail();
        scrubRef.current = null;
        paintHover(inFlyout ? undefined : item.id, inFlyout ? item.id : undefined, item.id);
        showTooltip(event.currentTarget, title);
        if (branchCloseTimer.current) clearTimeout(branchCloseTimer.current);
        if (!inFlyout && event.pointerType !== "touch") {
          if (branchTimer.current) clearTimeout(branchTimer.current);
          branchTimer.current = setTimeout(() => {
            if (children) openFlyout(item);
            else setFlyoutId(null);
          }, BRANCH_HOVER_DELAY);
        }
      }}
      onPointerMove={(event) => {
        if (!inFlyout && flyoutId === item.id && flyoutRef.current?.dataset.side !== "overlay") {
          updateSafeArea(event, flyoutRef.current, flyoutSafeRef.current);
        }
      }}
      onPointerLeave={() => {
        paintHover();
        hideTooltip();
        if (branchTimer.current) clearTimeout(branchTimer.current);
        if (!inFlyout && flyoutId === item.id && !hasOutlineFocus()) {
          branchCloseTimer.current = setTimeout(() => closeFlyout(), 300);
        }
      }}
      onFocus={() => {
        stopRail();
        scrubRef.current = null;
        if (skipFocusOpenRef.current) { skipFocusOpenRef.current = false; return; }
        if (!inFlyout) openFlyout(item);
      }}
      onKeyDown={(event) => {
        if (!inFlyout && children && event.key === "ArrowRight") {
          event.preventDefault();
          openFlyout(item, true);
        }
      }}>
      <button type="button" className="toc-item" aria-label={title}
        data-active={item.id === (inFlyout ? activeId : activeMainId)}
        style={{ paddingLeft: `${0.5 + Math.max(0, item.originalLevel - baseLevel) * 0.625}rem` }}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { scrollTo(item); if (pinned) closeOutline(); }}>
        <span className="toc-item-title">{numberAt(item.pos)}<HeadingTitle node={item.node} /></span>
        {isFolded(item) && <ChevronRight aria-label="Folded" />}
      </button>
      {children && <button type="button" className="toc-branch-trigger" aria-label={`Show sections in ${title}`}
        aria-expanded={flyoutId === item.id} aria-controls={flyoutId === item.id ? flyoutDomId : undefined}
        onMouseDown={event => event.preventDefault()}
        onClick={() => openFlyout(item, true)}><ChevronRight aria-hidden="true" /></button>}
    </div>;
  }

  function hasOutlineFocus() {
    return !!navRef.current?.contains(document.activeElement);
  }

  if (!editor || items.length === 0) return null;
  const minLevel = Math.min(...items.map(item => item.originalLevel));
  const section = hovered ? { ...hovered, start: 0, end: items.length } : null;

  return <nav ref={navRef} className="toc" data-compact={compact} aria-label="Table of contents"
    onKeyDown={(event) => {
      if (flyoutId && (event.key === "Escape" || event.key === "ArrowLeft")) {
        event.preventDefault();
        closeFlyout(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeOutline();
      }
    }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeOutline(); }}
    onPointerEnter={() => { if (closeTimer.current) clearTimeout(closeTimer.current); }}
    onPointerLeave={(event) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
      if (event.pointerType !== "touch" && !pinned && !hasOutlineFocus()) {
        freezeRail();
        closeTimer.current = setTimeout(closeOutline, compact || flyoutId ? 300 : 120);
      }
    }}>
    {section && <div ref={safeAreaRef} className="toc-safe-area" onPointerEnter={freezeRail} />}
    {section && <div ref={panelRef} className="toc-panel" aria-label="Outline headings" onKeyDown={navigateList}
      onPointerEnter={() => { stopRail(); scrubRef.current = null; }}
      onWheel={event => event.stopPropagation()} onScroll={hideTooltip}>
      {items.slice(section.start, section.end).filter(item => visibleIds.has(item.id)).map(item => renderRow(item, items[section.start].originalLevel))}
    </div>}
    {section && flyoutParent && descendants.length > 0 && <>
      <div key={flyoutId} ref={flyoutSafeRef} className="toc-safe-area toc-flyout-safe-area"
        onPointerEnter={() => {
          if (branchTimer.current) clearTimeout(branchTimer.current);
          if (branchCloseTimer.current) clearTimeout(branchCloseTimer.current);
        }} />
      <div ref={flyoutRef} id={flyoutDomId} className="toc-flyout" role="region" aria-label={`Contents of ${numberAt(flyoutParent.pos) + flyoutParent.textContent}`}
        onPointerEnter={() => {
          stopRail();
          scrubRef.current = null;
          if (branchTimer.current) clearTimeout(branchTimer.current);
          if (branchCloseTimer.current) clearTimeout(branchCloseTimer.current);
        }}
        onPointerLeave={() => { if (!hasOutlineFocus()) branchCloseTimer.current = setTimeout(() => closeFlyout(), 300); }}
        onKeyDown={event => {
          if (event.key === "ArrowLeft" || event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); closeFlyout(true);
          } else navigateList(event);
        }}
        onWheel={event => event.stopPropagation()} onScroll={hideTooltip}>
        <button type="button" className="toc-flyout-back" onMouseDown={event => event.preventDefault()} onClick={() => closeFlyout(true)}>
          <ChevronRight aria-hidden="true" />Back to outline
        </button>
        {descendants.map(item => renderRow(item, flyoutBaseLevel, true))}
      </div>
    </>}
    {section && tooltip && <div ref={tooltipRef} className="toc-title-tooltip" role="tooltip">{tooltip}</div>}
    <div className="toc-rail" onPointerEnter={scrubRail} onPointerMove={scrubRail}>
      {items.map((item, index) => {
        return <button key={item.id} ref={node => {
          if (node) dashRefs.current.set(item.id, node); else dashRefs.current.delete(item.id);
        }} data-heading-id={item.id} data-index={index} type="button" className="toc-dash" aria-label={numberAt(item.pos) + item.textContent}
          data-active={item.id === activeId} data-folded={isFolded(item)} data-related="false"
          onMouseDown={event => event.preventDefault()}
          onPointerDown={event => { pressTypeRef.current = event.pointerType; }}
          onFocus={event => {
            if (event.currentTarget.matches(":focus-visible")) {
              stopRail(); scrubRef.current = null;
              openSection(index, event.currentTarget);
            }
          }}
          onKeyDown={event => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              (panelRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? panelRef.current?.querySelector<HTMLElement>(".toc-item"))?.focus();
            }
          }}
          onClick={event => {
            const tapped = pressTypeRef.current === "touch";
            pressTypeRef.current = "";
            if (tapped && hovered?.start !== index) { openSection(index, event.currentTarget); setPinned(true); return; }
            scrollTo(item);
            if (pinned) closeOutline();
          }}>
          <span style={{ width: DASH_WIDTHS[Math.min(item.originalLevel - minLevel, DASH_WIDTHS.length - 1)] }} />
        </button>;
      })}
    </div>
  </nav>;
}

export function TableOfContents(props: { editor: Editor | null; store: TocStore; numbered?: boolean }) {
  return isNativeHost() ? null : <DesktopTableOfContents {...props} />;
}
