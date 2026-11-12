import { MiddleTruncate } from "./middle-truncate";
import { useState, type PointerEventHandler, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, closestCenter, pointerWithin } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronRight, Ellipsis, Folder } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { call } from '@/lib/backend';
import { queryClient } from '@/lib/query-client';
import { writeOperation } from '@/lib/write-lifecycle';
import { moveSidebarItem, sidebarLayout, type SidebarItem } from '@/lib/sidebar-layout';
import type { Module } from '@/lib/types';
import { CreateModuleButton } from './create-module';
import { Button } from './ui/button';
import { SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from './ui/sidebar';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Field, FieldError, FieldGroup } from './ui/field';

export const sidebarKey = ['sidebar-items'] as const;

function DropZone({ id, children, highlight = true }: { id: string; children: ReactNode; highlight?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} className={highlight && isOver ? 'rounded-md bg-sidebar-accent' : ''}>{children}</div>;
}

// The whole row is the drag source. Only the pointer listener is attached, so
// links and buttons inside keep their own keyboard behaviour; a drag starts
// after the pointer moves a few pixels, so a plain click still navigates.
function SortableRow({ item, children, disabled }: { item: SidebarItem; children: ReactNode; disabled: boolean }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  return <div ref={setNodeRef} data-sidebar-item={item.id} onPointerDown={listeners?.onPointerDown as PointerEventHandler | undefined}
    style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }} className="touch-none">
    {children}
  </div>;
}

// A drag ends with a pointerup over some row; swallow the click that follows so
// dropping a module does not also open it.
function suppressNextClick() {
  const swallow = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

export function SidebarModules({ modules, renderModule }: { modules: Module[]; renderModule: (module: Module) => ReactNode }) {
  const query = useQuery({ queryKey: sidebarKey, queryFn: () => call<SidebarItem[]>('sidebar_items') });
  const [editing, setEditing] = useState<SidebarItem | 'new' | null>(null);
  const [name, setName] = useState('');
  // The row being dragged, so a copy of it can follow the pointer.
  const [dragging, setDragging] = useState<{ id: string; width: number }>();
  const mutation = useMutation({
    mutationFn: (items: SidebarItem[]) => writeOperation(() => call('save_sidebar_items', { items })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sidebarKey }),
  });
  const items = sidebarLayout(modules, query.data ?? []);
  const dragged = dragging ? items.find(item => item.id === dragging.id) : undefined;
  const draggedModule = dragged ? modules.find(module => module.id === dragged.id) : undefined;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const save = (next: SidebarItem[], onSuccess?: () => void) => {
    next = [...items.filter(item => !next.some(entry => entry.id === item.id)), ...next];
    const changed = next.filter(item => JSON.stringify(item) !== JSON.stringify(query.data?.find(saved => saved.id === item.id)));
    // Show the new layout in the same tick as the drop. Dropping clears the drag offsets at
    // once, so waiting for the write and the refetch would snap rows back and then jump them.
    const previous = queryClient.getQueryData<SidebarItem[]>(sidebarKey);
    void queryClient.cancelQueries({ queryKey: sidebarKey });
    queryClient.setQueryData<SidebarItem[]>(sidebarKey, saved => {
      const merged = [...saved ?? []];
      for (const item of changed) {
        const index = merged.findIndex(entry => entry.id === item.id);
        if (index < 0) merged.push(item); else merged[index] = item;
      }
      return merged;
    });
    mutation.mutate(changed, { onSuccess, onError: () => queryClient.setQueryData(sidebarKey, previous) });
  };
  const edit = (item: SidebarItem | 'new') => { setEditing(item); setName(item === 'new' ? '' : item.name ?? ''); };
  const row = (item: SidebarItem): ReactNode => {
    const module = modules.find(module => module.id === item.id);
    return <SortableRow key={item.id} item={item} disabled={mutation.isPending || query.isPending || query.isError}>
      {item.name === null ? <SidebarMenu>{renderModule(module!)}</SidebarMenu> : <>
        <DropZone id={`folder:${item.id}`}><SidebarMenu><SidebarMenuItem>
          <SidebarMenuButton disabled={mutation.isPending} aria-expanded={!item.collapsed} onClick={() => save(items.map(entry => entry.id === item.id ? { ...entry, collapsed: !entry.collapsed } : entry))}>
            <ChevronRight className={`transition-transform ${item.collapsed ? '' : 'rotate-90'}`} /><Folder /><MiddleTruncate text={item.name} />
          </SidebarMenuButton>
          <DropdownMenu><DropdownMenuTrigger render={<SidebarMenuAction showOnHover disabled={mutation.isPending} aria-label={`Actions for ${item.name}`} />}><Ellipsis /></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem onClick={() => edit(item)}>Rename</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={() => save([{ ...item, deleted: true }])}>Delete folder (keep modules)</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem></SidebarMenu></DropZone>
        {!item.collapsed && <DropZone id={`folder:${item.id}:contents`}><div className="pl-4 pt-0.5 min-h-2 space-y-0.5" role="group" aria-label={item.name}>
          <SortableContext items={items.filter(entry => entry.folder_id === item.id).map(entry => entry.id)} strategy={verticalListSortingStrategy}>
            {items.filter(entry => entry.folder_id === item.id).map(row)}
          </SortableContext>
        </div></DropZone>}
      </>}
    </SortableRow>;
  };
  return <>
    <CreateModuleButton onNewFolder={() => edit('new')} />
    {(query.error || mutation.error) && <p role="alert">{(query.error ?? mutation.error)?.message}</p>}
    <DndContext sensors={sensors} collisionDetection={args => {
      const active = items.find(item => item.id === args.active.id);
      if (active?.name === null && args.pointerCoordinates) {
        const all = pointerWithin(args);
        const hits = all.filter(hit => hit.id !== args.active.id);
        const note = hits.find(hit => items.some(item => item.id === hit.id && item.name === null));
        // A folder is nested inside the root list, so prefer it over root.
        const zone = hits.find(hit => String(hit.id).startsWith('folder:')) ?? hits.find(hit => hit.id === 'root');
        if (note) return [note];
        // On its own slot: put down where it was picked up, so nothing is targeted.
        if (all.some(hit => hit.id === args.active.id)) return [];
        if (zone) {
          // Not over another row, but inside the list the row already belongs to (a gap, or its
          // own slot): the nearest sibling decides. Targeting the zone itself would light it up
          // and, on drop, send the row to the end of the list.
          const parent = zone.id === 'root' ? null : String(zone.id).slice('folder:'.length).replace(/:contents$/, '');
          if (active.folder_id === parent) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(container => {
            const item = items.find(item => item.id === container.id);
            return item && item.id !== active.id && item.folder_id === parent;
          }) });
          return [zone];
        }
      }
      return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(container => {
        const item = items.find(item => item.id === container.id);
        return item && item.id !== args.active.id && (active?.name === null || item.folder_id === null);
      }) });
    }} onDragStart={({ active }) => setDragging({ id: String(active.id), width: document.querySelector(`[data-sidebar-item="${window.CSS.escape(String(active.id))}"]`)?.getBoundingClientRect().width ?? 0 })}
    onDragCancel={() => setDragging(undefined)}
    onDragEnd={({ active, over }) => {
      setDragging(undefined);
      suppressNextClick();
      if (!over || mutation.isPending) return;
      const target = String(over.id).replace(/:contents$/, '');
      save(moveSidebarItem(items, String(active.id), target));
    }}>
      {/* The whole list is the top-level drop target, for moving a module out of a folder. */}
      <DropZone id="root" highlight={false}><SortableContext items={items.filter(item => item.folder_id === null).map(item => item.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5 pb-2">{items.filter(item => item.folder_id === null).map(row)}</div>
      </SortableContext></DropZone>
      {/* A folder is not a slot in the list, so the row cannot preview by moving into it:
          a copy follows the pointer instead. Portalled out of the scrolling sidebar. */}
      {createPortal(<DragOverlay dropAnimation={null}>{dragged && <div data-sidebar-drag-preview inert aria-hidden style={{ width: dragging?.width }}
        className="floating-surface cursor-grabbing rounded-md text-sm">
        <SidebarMenu>{dragged.name === null
          ? (draggedModule && renderModule(draggedModule))
          : <SidebarMenuItem><SidebarMenuButton><ChevronRight /><Folder /><span>{dragged.name}</span></SidebarMenuButton></SidebarMenuItem>}</SidebarMenu>
      </div>}</DragOverlay>, document.body)}
    </DndContext>
    <Dialog open={editing !== null} onOpenChange={open => { if (!open) setEditing(null); }}><DialogContent>
      <form onSubmit={event => {
        event.preventDefault();
        if (!name.trim() || mutation.isPending) return;
        const item: SidebarItem = editing === 'new' ? { id: `folder-${crypto.randomUUID()}`, name: name.trim(), folder_id: null, sort_order: Math.max(-1, ...items.map(item => item.sort_order)) + 1, collapsed: false, deleted: false } : { ...editing!, name: name.trim() };
        save([item], () => setEditing(null));
      }}>
        <DialogHeader><DialogTitle>{editing === 'new' ? 'New folder' : 'Rename folder'}</DialogTitle></DialogHeader>
        <FieldGroup className="pb-2 pt-4">
          <Field data-invalid={!!mutation.error}>
            <Label htmlFor="folder-name">Name</Label>
            <Input id="folder-name" value={name} onChange={event => setName(event.target.value)} placeholder="Year 1" autoFocus disabled={mutation.isPending}
              aria-invalid={!!mutation.error} aria-describedby={mutation.error ? "folder-name-error" : undefined} />
            <FieldError id="folder-name-error">{mutation.error?.message}</FieldError>
          </Field>
        </FieldGroup>
        <DialogFooter><DialogClose render={<Button variant="outline">Cancel</Button>} /><Button type="submit" disabled={!name.trim() || mutation.isPending}>Save</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </>;
}
