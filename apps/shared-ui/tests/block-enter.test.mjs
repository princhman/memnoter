import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '@tiptap/core';
import { editorExtensions } from './support/editor.mjs';
const text = value => ({ type: 'text', text: value });
const p = value => ({ type: 'paragraph', content: value ? [text(value)] : [] });
const kinds = ['codeBlock', 'mathBlock', 'blockquote', 'callout', 'details', 'bulletList', 'orderedList'];
function block(kind, empty = false) {
  const lines = [p('alpha beta'), ...(empty ? [p('')] : [])];
  if (kind === 'codeBlock' || kind === 'mathBlock') return { type: kind, content: [text('alpha beta' + (empty ? '\n' : ''))] };
  if (kind === 'details') return { type: kind, attrs: { open: true }, content: [{ type: 'detailsSummary', content: [text('Title')] }, { type: 'detailsContent', content: lines }] };
  if (kind.endsWith('List')) return { type: kind, content: lines.map(line => ({ type: 'listItem', content: [line] })) };
  return { type: 'blockquote', content: kind === 'callout' ? [p('Note'), ...lines] : lines };
}
// ProseMirror maps Mod to Cmd when navigator.platform looks like a Mac.
const mac = /Mac|iP(hone|[oa]d)/.test(globalThis.navigator?.platform ?? '');
function press(editor, key) {
  const mod = key === 'Mod-Enter';
  const event = { key: 'Enter', keyCode: 13, shiftKey: key === 'Shift-Enter', ctrlKey: mod && !mac, metaKey: mod && mac, preventDefault() {} };
  return editor.state.plugins.some(plugin => plugin.props.handleKeyDown?.(editor.view, event));
}
for (const kind of kinds) {
  for (const key of ['Enter', 'Shift-Enter', 'Mod-Enter', 'empty Enter']) {
    test(`${kind}: ${key}`, () => {
      const empty = key === 'empty Enter';
      const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [block(kind, empty), p('Following')] } });
      editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
      try {
        let pos;
        editor.state.doc.descendants((node, offset) => {
          if (node.isTextblock && (empty ? !node.content.size || node.textContent.endsWith('\n') : node.textContent === 'alpha beta')) pos = offset + 1 + (empty ? node.content.size : 5);
        });
        editor.commands.setTextSelection(pos);
        assert.equal(press(editor, empty ? 'Enter' : key), true);
        editor.state.doc.check();
        const { $head } = editor.state.selection;
        if (key === 'Mod-Enter' || empty) {
          assert.equal($head.depth, 1);
          assert.equal($head.parent.type.name, 'paragraph');
          assert.equal($head.parent.content.size, 0);
          assert.equal(editor.state.doc.child(2).textContent, 'Following');
          assert.equal(editor.state.doc.firstChild.textContent.includes('alpha beta'), true);
          if (empty) assert.equal(editor.state.doc.firstChild.textContent.endsWith('\n'), false);
          if (empty && !['codeBlock','mathBlock'].includes(kind)) {
            let emptyParagraphs = 0;
            editor.state.doc.firstChild.descendants(n => { if (n.type.name === 'paragraph' && !n.content.size) emptyParagraphs++; });
            assert.equal(emptyParagraphs, 0);
          }
        } else {
          assert.ok($head.depth > 1 || ['codeBlock', 'mathBlock'].includes(kind));
          if (['codeBlock', 'mathBlock'].includes(kind)) assert.equal(editor.state.doc.firstChild.textContent, 'alpha\n beta');
          else if (key === 'Shift-Enter') assert.equal($head.parent.child(1).type.name, 'hardBreak');
          else assert.equal($head.parent.textContent, ' beta');
        }
      } finally { editor.destroy(); }
    });
  }
}

for (const kind of kinds) {
  test(`${kind}: Shift-Enter at empty last line stays inside; Enter then leaves`, () => {
    const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [block(kind, true)] } });
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    try {
      let end;
      editor.state.doc.descendants((n, pos) => { if (n.isTextblock && pos < editor.state.doc.firstChild.nodeSize) end = pos + 1 + n.content.size; });
      editor.commands.setTextSelection(end);
      assert.equal(press(editor, 'Shift-Enter'), true);
      assert.ok(editor.state.selection.$head.depth > 1 || ['codeBlock', 'mathBlock'].includes(kind));
      assert.equal(press(editor, 'Enter'), true);
      assert.equal(editor.state.selection.$head.depth, 1);
      editor.state.doc.check();
    } finally { editor.destroy(); }
  });
}

test('Cmd/Ctrl-Enter outside blocks reaches existing lower-priority bindings', () => {
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [p('Outside')] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    editor.commands.setTextSelection(3);
    assert.equal(press(editor, 'Mod-Enter'), true);
    assert.equal(editor.state.selection.$head.parent.child(1).type.name, 'hardBreak');
    assert.equal(editor.state.doc.textContent, 'Outside');
  } finally { editor.destroy(); }
});

for (const kind of kinds) {
  for (const edge of ['start', 'end']) {
    test(`${kind}: Cmd/Ctrl-Enter from ${edge} preserves all content`, () => {
      const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [block(kind), p('Following')] } });
      editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
      try {
        const before = editor.state.doc.firstChild;
        editor.state.doc.descendants((node, pos) => { if (node.isTextblock && node.textContent === 'alpha beta') editor.commands.setTextSelection(pos + 1 + (edge === 'end' ? node.content.size : 0)); });
        assert.equal(press(editor, 'Mod-Enter'), true);
        assert.ok(editor.state.doc.firstChild.eq(before));
        assert.equal(editor.state.selection.$head.depth, 1);
        assert.equal(editor.state.doc.child(1).content.size, 0);
      } finally { editor.destroy(); }
    });
  }
}

test('foldable title Enter opens the body; Shift-Enter stays in title; Cmd/Ctrl-Enter leaves', () => {
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [block('details')] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    editor.commands.setTextSelection(4);
    assert.equal(press(editor, 'Shift-Enter'), true);
    assert.equal(editor.state.selection.$head.parent.type.name, 'detailsSummary');
    assert.equal(press(editor, 'Enter'), true);
    assert.equal(editor.state.selection.$head.parent.type.name, 'paragraph');
    assert.equal(editor.state.selection.$head.node(-1).type.name, 'detailsContent');
    assert.equal(press(editor, 'Mod-Enter'), true);
    assert.equal(editor.state.selection.$head.depth, 1);
    editor.state.doc.check();
  } finally { editor.destroy(); }
});

test('nested code exits into its quote, retaining the surrounding block', () => {
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [{type:'blockquote',content:[block('codeBlock')]}] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    editor.commands.setTextSelection(4);
    assert.equal(press(editor, 'Mod-Enter'), true);
    assert.equal(editor.state.selection.$head.node(-1).type.name, 'blockquote');
    assert.equal(editor.state.selection.$head.parent.type.name, 'paragraph');
    assert.equal(editor.state.doc.firstChild.firstChild.textContent, 'alpha beta');
    editor.state.doc.check();
  } finally { editor.destroy(); }
});

for (const kind of ['bulletList', 'orderedList']) {
  test(`${kind}: Enter in an empty non-final item creates a sibling item`, () => {
    const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [{ type: kind, content: [p(''), p('later')].map(line => ({ type: 'listItem', content: [line] })) }] } });
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    try {
      editor.commands.setTextSelection(3);
      assert.equal(press(editor, 'Enter'), true);
      assert.equal(editor.state.doc.firstChild.childCount, 3);
      assert.equal(editor.state.doc.firstChild.lastChild.textContent, 'later');
      assert.equal(editor.state.selection.$head.node(-2).type.name, kind);
      editor.state.doc.check();
    } finally { editor.destroy(); }
  });
}

for (const [key, pos] of [['Mod-Enter', 1], ['Mod-Enter', 3], ['Mod-Enter', 6], ['Enter', 6]]) {
  test(`heading: ${key} at ${pos} preserves heading text and uses a paragraph below`, () => {
    const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] }, p('Following')] } });
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    try {
      editor.commands.setTextSelection(pos);
      assert.equal(press(editor, key), true);
      assert.equal(editor.state.doc.firstChild.type.name, 'heading');
      assert.equal(editor.state.doc.firstChild.textContent, 'Title');
      assert.equal(editor.state.doc.child(1).type.name, 'paragraph');
      assert.equal(editor.state.doc.child(1).content.size, 0);
      assert.equal(editor.state.selection.$head.parent.type.name, 'paragraph');
      assert.equal(editor.state.doc.child(2).textContent, 'Following');
    } finally { editor.destroy(); }
  });
}
