import { useState, type ReactNode } from 'react';
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, useDroppable, closestCenter, pointerWithin } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronRight, Ellipsis, Folder, GripVertical } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { call } from '@/lib/backend';
import { queryClient } from '@/lib/query-client';
import { writeOperation } from '@/lib/write-lifecycle';
import { moveSidebarItem, sidebarLayout, type SidebarItem } from '@/lib/sidebar-layout';
import type { Module } from '@/lib/types';
import CreateModule from './create-module';
import { Button } from './ui/button';
import { SidebarMenu } from './ui/sidebar';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

export const sidebarKey = ['sidebar-items'] as const;

function DropZone({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} className={isOver ? 'rounded-md bg-accent' : ''}>{children}</div>;
}

function SortableRow({ item, label, children, disabled }: { item: SidebarItem; label: string; children: ReactNode; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }} className="flex items-start gap-0.5">
    <button type="button" disabled={disabled} {...attributes} {...listeners} aria-label={`Move ${label}`} className="text-muted-foreground hover:text-foreground mt-2 shrink-0 touch-none cursor-grab"><GripVertical className="size-3" /></button>
    <div className="min-w-0 flex-1">{children}</div>
  </div>;
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const save = (next: SidebarItem[]) => mutation.mutate(next.filter(item => JSON.stringify(item) !== JSON.stringify(query.data?.find(saved => saved.id === item.id))));
  const edit = (item: SidebarItem | 'new') => { setEditing(item); setName(item === 'new' ? '' : item.name ?? ''); };
  const row = (item: SidebarItem): ReactNode => {
    const module = modules.find(module => module.id === item.id);
    return <SortableRow key={item.id} item={item} label={item.name ?? module?.name ?? ''} disabled={mutation.isPending || query.isPending || query.isError}>
      {item.name === null ? <SidebarMenu>{renderModule(module!)}</SidebarMenu> : <>
        <div className="flex items-center">
          <DropZone id={`folder:${item.id}`}><Button disabled={mutation.isPending} variant="ghost" className="justify-start max-w-full" aria-expanded={!item.collapsed} onClick={() => save(items.map(entry => entry.id === item.id ? { ...entry, collapsed: !entry.collapsed } : entry))}>
            <ChevronRight className={`size-3 ${item.collapsed ? '' : 'rotate-90'}`} /><Folder className="size-4" /><span className="truncate">{item.name}</span>
          </Button></DropZone>
          <DropdownMenu><DropdownMenuTrigger render={<Button disabled={mutation.isPending} variant="ghost" size="icon-sm" aria-label={`Actions for ${item.name}`} />}><Ellipsis /></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem onClick={() => edit(item)}>Rename</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={() => save([{ ...item, deleted: true }])}>Delete folder (keep modules)</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
        </div>
        {!item.collapsed && <DropZone id={`folder:${item.id}:contents`}><div className="pl-3 min-h-7" role="group" aria-label={item.name}>
          <SortableContext items={items.filter(entry => entry.folder_id === item.id).map(entry => entry.id)} strategy={verticalListSortingStrategy}>
            {items.filter(entry => entry.folder_id === item.id).map(row)}
          </SortableContext>
        </div></DropZone>}
      </>}
    </SortableRow>;
  };
  return <>
    <CreateModule onNewFolder={() => edit('new')} />
    {(query.error || mutation.error) && <p role="alert">{(query.error ?? mutation.error)?.message}</p>}
    <DndContext sensors={sensors} collisionDetection={args => {
      const active = items.find(item => item.id === args.active.id);
      if (active?.name === null && args.pointerCoordinates) {
        const hits = pointerWithin(args).filter(hit => hit.id !== args.active.id);
        const note = hits.find(hit => items.some(item => item.id === hit.id && item.name === null));
        const zone = hits.find(hit => String(hit.id).startsWith('folder:') || hit.id === 'root');
        if (note || zone) return [note ?? zone!];
      }
      return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(container => {
        const item = items.find(item => item.id === container.id);
        return item && item.id !== args.active.id && (active?.name === null || item.folder_id === null);
      }) });
    }} onDragEnd={({ active, over }) => {
      if (!over || mutation.isPending) return;
      const target = String(over.id).replace(/:contents$/, '');
      save(moveSidebarItem(items, String(active.id), target));
    }}>
      <SortableContext items={items.filter(item => item.folder_id === null).map(item => item.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5">{items.filter(item => item.folder_id === null).map(row)}</div>
      </SortableContext>
      <DropZone id="root"><div className="text-muted-foreground p-2 text-xs">Move to top level</div></DropZone>
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
