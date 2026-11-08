export type SidebarItem = {
  id: string;
  name: string | null;
  folder_id: string | null;
  sort_order: number;
  collapsed: boolean;
  deleted: boolean;
};

export function sidebarLayout(modules: { id: string }[], saved: SidebarItem[]): SidebarItem[] {
  const folders = saved.filter(item => item.name !== null && !item.deleted);
  const max = Math.max(-1, ...saved.map(item => item.sort_order));
  // A missing or deleted folder releases its modules, including concurrent moves.
  const notes = modules.map((module, index) => {
    const item = saved.find(item => item.id === module.id && item.name === null);
    return item ? { ...item, folder_id: folders.some(folder => folder.id === item.folder_id) ? item.folder_id : null }
      : { id: module.id, name: null, folder_id: null, sort_order: max + index + 1, collapsed: false, deleted: false };
  });
  return [...folders, ...notes].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
}

// A folder body receives modules; its drag handle participates in root ordering.
export function moveSidebarItem(items: SidebarItem[], id: string, target: string): SidebarItem[] {
  const active = items.find(item => item.id === id);
  if (!active) return items;
  const folderTarget = target.startsWith('folder:') ? target.slice(7) : null;
  const over = items.find(item => item.id === target);
  if (folderTarget && (active.name !== null || !items.some(item => item.id === folderTarget && item.name !== null))) return items;
  if (id === target) return items;
  const parent = folderTarget ?? (target === 'root' ? null : over?.folder_id ?? null);
  if (active.name !== null && parent !== null) return items;
  const ordered = items.filter(item => item.folder_id === parent).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  const index = over ? ordered.findIndex(item => item.id === over.id) : -1;
  const siblings = ordered.filter(item => item.id !== id);
  siblings.splice(index < 0 ? siblings.length : index, 0, { ...active, folder_id: parent });
  const positions = new Map(siblings.map((item, index) => [item.id, { ...item, sort_order: index }]));
  return items.map(item => positions.get(item.id) ?? item);
}
