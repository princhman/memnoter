import { useState, type PointerEventHandler, type ReactNode } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, useDroppable, closestCenter, pointerWithin } from '@dnd-kit/core';
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
  const mutation = useMutation({
    mutationFn: (items: SidebarItem[]) => writeOperation(() => call('save_sidebar_items', { items })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sidebarKey }),
  });
  const items = sidebarLayout(modules, query.data ?? []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const save = (next: SidebarItem[]) => mutation.mutate(next.filter(item => JSON.stringify(item) !== JSON.stringify(query.data?.find(saved => saved.id === item.id))));
  const edit = (item: SidebarItem | 'new') => { setEditing(item); setName(item === 'new' ? '' : item.name ?? ''); };
  const row = (item: SidebarItem): ReactNode => {
    const module = modules.find(module => module.id === item.id);
    return <SortableRow key={item.id} item={item} disabled={mutation.isPending || query.isPending || query.isError}>
      {item.name === null ? <SidebarMenu>{renderModule(module!)}</SidebarMenu> : <>
        <DropZone id={`folder:${item.id}`}><SidebarMenu><SidebarMenuItem>
          <SidebarMenuButton disabled={mutation.isPending} aria-expanded={!item.collapsed} onClick={() => save(items.map(entry => entry.id === item.id ? { ...entry, collapsed: !entry.collapsed } : entry))}>
            <ChevronRight className={`transition-transform ${item.collapsed ? '' : 'rotate-90'}`} /><Folder /><span>{item.name}</span>
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
        const hits = pointerWithin(args).filter(hit => hit.id !== args.active.id);
        const note = hits.find(hit => items.some(item => item.id === hit.id && item.name === null));
        // A folder is nested inside the root list, so prefer it over root.
        const zone = hits.find(hit => String(hit.id).startsWith('folder:')) ?? hits.find(hit => hit.id === 'root');
        if (note || zone) return [note ?? zone!];
      }
      return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(container => {
        const item = items.find(item => item.id === container.id);
        return item && item.id !== args.active.id && (active?.name === null || item.folder_id === null);
      }) });
    }} onDragEnd={({ active, over }) => {
      suppressNextClick();
      if (!over || mutation.isPending) return;
      const target = String(over.id).replace(/:contents$/, '');
      save(moveSidebarItem(items, String(active.id), target));
    }}>
      {/* The whole list is the top-level drop target, for moving a module out of a folder. */}
      <DropZone id="root" highlight={false}><SortableContext items={items.filter(item => item.folder_id === null).map(item => item.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5 pb-2">{items.filter(item => item.folder_id === null).map(row)}</div>
      </SortableContext></DropZone>
    </DndContext>
    <Dialog open={editing !== null} onOpenChange={open => { if (!open) setEditing(null); }}><DialogContent>
      <form onSubmit={event => {
        event.preventDefault();
        if (!name.trim() || mutation.isPending) return;
        const item: SidebarItem = editing === 'new' ? { id: `folder-${crypto.randomUUID()}`, name: name.trim(), folder_id: null, sort_order: Math.max(-1, ...items.map(item => item.sort_order)) + 1, collapsed: false, deleted: false } : { ...editing!, name: name.trim() };
        mutation.mutate([item], { onSuccess: () => setEditing(null) });
      }}>
        <DialogHeader><DialogTitle>{editing === 'new' ? 'New folder' : 'Rename folder'}</DialogTitle></DialogHeader>
        <Label htmlFor="folder-name">Name</Label><Input id="folder-name" value={name} onChange={event => setName(event.target.value)} autoFocus />
        {mutation.error && <p role="alert">{mutation.error.message}</p>}
        <DialogFooter><DialogClose render={<Button variant="outline">Cancel</Button>} /><Button type="submit" disabled={!name.trim() || mutation.isPending}>Save</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </>;
}
