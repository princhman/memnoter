import { useDraggable, useDroppable, useDndMonitor } from "@dnd-kit/core";
import { useState } from "react";
import { SidebarMenuItem, SidebarMenuButton } from "./ui/sidebar";
import { MiddleTruncate } from "./middle-truncate";

type SectionDrag = { kind: "section"; moduleId: string; headingId: string; title: string; number?: string };

export function isSectionDrag(data: unknown): data is SectionDrag {
  return typeof data === "object" && data !== null &&
    "kind" in data && data.kind === "section" &&
    "moduleId" in data && typeof data.moduleId === "string" &&
    "headingId" in data && typeof data.headingId === "string" && !!data.headingId &&
    "title" in data && typeof data.title === "string" &&
    (!("number" in data) || data.number === undefined || typeof data.number === "string");
}

export function SidebarSectionLabel({ title, number }: { title: string; number?: string }) {
  return <>
    {number && <span className="shrink-0 tabular-nums text-muted-foreground">{number}</span>}
    <MiddleTruncate text={title} />
  </>;
}

export function SidebarSectionRow({ moduleId, headingId, title, number, selected, canReorder, onClick }: {
  moduleId: string; headingId: string | null; title: string; number?: string; selected: boolean; canReorder: boolean; onClick: () => void;
}) {
  const draggable = canReorder && !!headingId;
  const id = `section:${moduleId}:${headingId ?? `untitled-${title}-${number}`}`;
  const data: SectionDrag = { kind: "section", moduleId, headingId: headingId ?? "", title, number };
  const drag = useDraggable({ id, disabled: !draggable, data });
  const drop = useDroppable({ id, disabled: !draggable, data });
  const [pointerY, setPointerY] = useState(0);
  useDndMonitor({
    onDragMove: ({ over, activatorEvent, delta }) => {
      if (over?.id === id && activatorEvent instanceof PointerEvent) setPointerY(activatorEvent.clientY + delta.y);
    },
    onDragOver: ({ over, activatorEvent, delta }) => {
      if (over?.id === id && activatorEvent instanceof PointerEvent) setPointerY(activatorEvent.clientY + delta.y);
    },
  });
  const rect = drop.node.current?.getBoundingClientRect();
  const after = rect && pointerY >= rect.top + rect.height / 2;
  return <SidebarMenuItem ref={node => { drag.setNodeRef(node); drop.setNodeRef(node); }}
    data-sidebar-section={headingId ?? undefined}
    className={`relative ${drag.isDragging ? "opacity-40" : ""}`}>
    {drop.isOver && <span aria-hidden="true" className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary ${after ? "-bottom-px" : "-top-px"}`} />}
    <SidebarMenuButton isActive={selected} aria-current={selected ? "location" : undefined}
      title={number ? `${number} ${title}` : title}
      className={draggable ? "cursor-grab active:cursor-grabbing" : undefined}
      onPointerDown={event => drag.listeners?.onPointerDown?.(event)} onClick={onClick}>
      <SidebarSectionLabel title={title} number={number} />
    </SidebarMenuButton>
  </SidebarMenuItem>;
}
