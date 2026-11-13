import type { Command } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { cardGroupsOf, groupOpener, parseBlock } from './cards';

export type GroupKind = 'list' | 'block';
export const insertGroupCard = (kind: GroupKind): Command => ({ tr, dispatch }) => {
  const { $head } = tr.selection;
  if ($head.depth !== 1 || !['paragraph', 'heading'].includes($head.parent.type.name) || parseBlock($head.parent).cards.length || groupOpener($head.parent) || cardGroupsOf(tr.doc).some(g => $head.pos >= g.from && $head.pos < g.to)) return false;
  if (dispatch) {
    const pos = $head.before(), node = $head.parent;
    const end = pos + node.nodeSize;
    const marker = ` ::${kind}`;
    const p = tr.doc.type.schema.nodes.paragraph;
    const answer = kind === 'list' ? tr.doc.type.schema.nodes.bulletList.create(null, tr.doc.type.schema.nodes.listItem.create(null, p.create())) : p.create();
    tr.insert(end, [answer, p.create(null, tr.doc.type.schema.text('::end')), p.create()]);
    tr.insertText(marker, end - 1);
    tr.setNodeAttribute(pos, 'cardGroup', kind);
    tr.setSelection(TextSelection.create(tr.doc, node.content.size ? end + marker.length + (kind === 'list' ? 3 : 1) : pos + 1));
  }
  return true;
};

export const makeGroupCard = (kind: GroupKind): Command => ({ tr, dispatch }) => {
  const { $from, $to, empty, from, to } = tr.selection;
  if (empty || $from.depth !== 1 || $from.parentOffset !== 0 || !['paragraph', 'heading'].includes($from.parent.type.name) || !$from.parent.textContent.trim()) return false;
  // The final endpoint may sit at the end of a paragraph within a list.
  const lastPos = $to.depth ? $to.after(1) : to;
  const firstPos = $from.before();
  if ($to.depth && to !== lastPos - $to.depth) return false;
  const blocks: import('@tiptap/pm/model').Node[] = [];
  tr.doc.nodesBetween(firstPos, lastPos, (node) => { blocks.push(node); return false; });
  if (blocks.length < 2 || kind === 'list' && (blocks.length !== 2 || !['bulletList', 'orderedList'].includes(blocks[1].type.name))) return false;
  let invalid = cardGroupsOf(tr.doc).some(g => g.from < lastPos && g.to > firstPos);
  for (const block of blocks) {
    const check = (n: import('@tiptap/pm/model').Node) => {
      if (!['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'mathBlock', 'text', 'inlineMath', 'hardBreak'].includes(n.type.name) || n.attrs.clozeNote || n.attrs.cloze || n.isTextblock && (parseBlock(n).cards.length || groupOpener(n) || n.textContent === '::end')) invalid = true;
    };
    check(block); block.descendants(check);
  }
  if (kind === 'list' && Array.from({length: blocks[1].childCount}, (_, i) => blocks[1].child(i)).some(n => !n.textContent.trim())) invalid = true;
  if (invalid || !blocks.slice(1).some(n => n.textContent.trim())) return false;
  if (dispatch) {
    tr.insert(lastPos, tr.doc.type.schema.nodes.paragraph.create(null, tr.doc.type.schema.text('::end')));
    const marker = ` ::${kind}`;
    tr.insertText(marker, firstPos + $from.parent.nodeSize - 1);
    tr.setNodeAttribute(firstPos, 'cardGroup', kind);
    tr.setSelection(TextSelection.create(tr.doc, from, to + marker.length));
  }
  return true;
};

export const removeGroupCard = (kind: GroupKind): Command => ({ tr, dispatch }) => {
  const group = cardGroupsOf(tr.doc).find(g => g.valid && g.kind === kind && tr.selection.from >= g.from && tr.selection.to <= g.to);
  if (!group || group.closer === null) return false;
  if (dispatch) {
    tr.delete(group.closer, group.to);
    tr.delete(group.marker.from - 1, group.marker.to);
    tr.setNodeAttribute(group.from, 'cardGroup', null);
  }
  return true;
};
