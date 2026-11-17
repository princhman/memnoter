import { useDraggable, useDroppable, useDndContext, useDndMonitor } from "@dnd-kit/core";
import { useState } from "react";
import type { SectionSource } from "@/lib/section-moves";
import { SidebarMenuItem, SidebarMenuButton } from "./ui/sidebar";
import { MiddleTruncate } from "./middle-truncate";

export function useSectionModuleDrop(moduleId: string) {
  const drop = useDroppable({ id: `section-module:${moduleId}`, data: { kind: "section-module", moduleId } });
  const { active } = useDndContext();
  return { setNodeRef: drop.setNodeRef, isOver: drop.isOver && active?.data.current?.kind === "section" };
}

export function SidebarSectionRow({ moduleId, headingId, title, number, selected, onClick }: {
  moduleId: string; headingId: string | null; title: string; number?: string; selected: boolean; onClick: () => void;
}) {
  // A closed note's empty H1 saved without an id is listed for its number,
  // but cannot be dragged or targeted until opening the note gives it an id.
  const source: SectionSource = { moduleId, headingId: headingId ?? "" };
  const id = `section:${moduleId}:${headingId ?? `untitled-${title}-${number}`}`;
  const drag = useDraggable({ id, disabled: !headingId, data: { kind: "section", ...source, title: number ? `${number} ${title}` : title } });
  const drop = useDroppable({ id, disabled: !headingId, data: { kind: "section", ...source } });
  const { active } = useDndContext();
  const [pointerY, setPointerY] = useState(0);
  useDndMonitor({
    onDragMove: event => { if (drop.isOver) setPointerY((event.activatorEvent as PointerEvent).clientY + event.delta.y); },
    onDragOver: event => { if (event.over?.id === id) setPointerY((event.activatorEvent as PointerEvent).clientY + event.delta.y); },
  });
  const over = drop.isOver && active?.data.current?.kind === "section" && active.id !== id;
  const rect = drop.node.current?.getBoundingClientRect();
  const after = rect && pointerY >= rect.top + rect.height / 2;
  return <SidebarMenuItem ref={node => { drag.setNodeRef(node); drop.setNodeRef(node); }}
    data-sidebar-section={headingId ?? undefined}
    className={`relative ${drag.isDragging ? "opacity-40" : ""}`}>
    {over && <span aria-hidden="true" className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary ${after ? "-bottom-px" : "-top-px"}`} />}
    <SidebarMenuButton isActive={selected} aria-current={selected ? "location" : undefined}
      title={number ? `${number} ${title}` : title}
      className={headingId ? "cursor-grab active:cursor-grabbing" : undefined}
      onPointerDown={drag.listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined} onClick={onClick}>
      {number && <span className="shrink-0 tabular-nums text-muted-foreground">{number}</span>}
      <MiddleTruncate text={title} />
    </SidebarMenuButton>
  </SidebarMenuItem>;
}
