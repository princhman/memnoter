import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sidebarLayout, moveSidebarItem } from '../src/lib/sidebar-layout.ts';

const item = (id, fields = {}) => ({ id, name: null, folder_id: null, sort_order: 0, collapsed: false, deleted: false, ...fields });
const folder = item('folder', { name: 'Study', sort_order: 1 });
const modules = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('existing modules keep order and new modules appear after saved entries', () => {
  const layout = sidebarLayout(modules, [item('b'), item('a', { sort_order: 1 })]);
  assert.deepEqual(layout.map(item => item.id), ['b', 'a', 'c']);
});

test('dragging reorders modules and folders at top level', () => {
  const items = sidebarLayout(modules, [item('a'), folder, item('b', { sort_order: 2 })]);
  const moved = moveSidebarItem(items, 'b', 'a');
  assert.deepEqual(sidebarLayout(modules, moved).map(item => item.id), ['b', 'a', 'folder', 'c']);
  const movedFolder = moveSidebarItem(moved, 'folder', 'b');
  assert.deepEqual(sidebarLayout(modules, movedFolder).map(item => item.id), ['folder', 'b', 'a', 'c']);
});

test('modules enter empty or collapsed folders and can return to top level', () => {
  const items = sidebarLayout(modules, [folder]);
  const inside = moveSidebarItem(items, 'a', 'folder:folder');
  assert.equal(inside.find(item => item.id === 'a').folder_id, 'folder');
  const outside = moveSidebarItem(inside, 'a', 'root');
  assert.equal(outside.find(item => item.id === 'a').folder_id, null);
  assert.equal(outside.find(item => item.id === 'a').sort_order, 3);
});

test('deleting a folder returns its modules to root without losing modules', () => {
  const saved = [item('a', { folder_id: 'folder' }), { ...folder, deleted: true }];
  const layout = sidebarLayout(modules, saved);
  assert.deepEqual(layout.map(item => item.id).sort(), ['a', 'b', 'c']);
  assert.equal(layout.find(item => item.id === 'a').folder_id, null);
  assert.equal(sidebarLayout(modules, [item('a', { folder_id: 'missing' })])[0].folder_id, null);
});

test('folders cannot be nested and dragging an item onto itself changes nothing', () => {
  const items = [folder, item('other', { name: 'Other' })];
  assert.equal(moveSidebarItem(items, 'other', 'folder:folder'), items);
  assert.equal(moveSidebarItem(items, 'folder', 'folder'), items);
});

test('dragging down places an item after its target', () => {
  const items = sidebarLayout(modules, []);
  const moved = moveSidebarItem(items, 'a', 'b');
  assert.deepEqual(sidebarLayout(modules, moved).map(item => item.id), ['b', 'a', 'c']);
});
