import { editorExtensions } from "./support/editor.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor } from '@tiptap/core';
import { execEditor, editorState } from '../src/editor-host/commands.ts';

function createEditor() {
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Selected text' }] }] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.commands.setTextSelection({ from: 1, to: 9 });
  return editor;
}

test('native toolbar formats the selected text and reports the resulting document and selection', () => {
  const editor = createEditor();
  try {
    for (const mark of ['bold', 'italic', 'underline', 'strike', 'code']) {
      assert.equal(execEditor(editor, mark), true);
      assert.ok(editorState(editor).marks.includes(mark));
      assert.equal(execEditor(editor, mark), true);
      assert.ok(!editorState(editor).marks.includes(mark));
    }
    execEditor(editor, 'setHighlight', { color: 'purple' });
    assert.equal(editorState(editor).highlightColor, 'purple');
    assert.ok(editorState(editor).marks.includes('highlight'));
    execEditor(editor, 'removeHighlight');
    assert.equal(editorState(editor).highlightColor, null);
    assert.ok(!editorState(editor).marks.includes('highlight'));
    for (const level of [1, 2, 3]) {
      assert.equal(execEditor(editor, 'heading', { level }), true);
      assert.equal(editorState(editor).headingLevel, 1, "the first heading is normalized to the document root level");
    }
    execEditor(editor, 'paragraph');
    assert.equal(editorState(editor).blockType, 'paragraph');
    for (const command of ['bulletList', 'orderedList', 'blockquote']) {
      execEditor(editor, command);
      assert.equal(editorState(editor)[command], true);
      execEditor(editor, command);
      assert.equal(editorState(editor)[command], false);
    }
    assert.equal(editorState(editor).hasSelection, true);
    execEditor(editor, 'link', { href: 'https://example.com' });
    assert.equal(editor.getAttributes('link').href, 'https://example.com');
    execEditor(editor, 'link', { href: null });
    assert.equal(editor.isActive('link'), false);
    execEditor(editor, 'makeCard');
    assert.equal(editor.state.doc.textContent, '{{Selected}} text');
  } finally { editor.destroy(); }
});

test('invalid native commands cannot invoke arbitrary editor methods or mutate content', () => {
  const editor = createEditor();
  try {
    const before = editor.getJSON();
    for (const [command, args] of [['destroy', {}], ['heading', { level: 7 }], ['link', {}], ['insertImage', {}], ['fold', { id: 'missing' }]]) {
      assert.throws(() => execEditor(editor, command, args));
      assert.deepEqual(editor.getJSON(), before);
    }
  } finally { editor.destroy(); }
});


test('native focus follows the innermost section through body text and section boundaries', () => {
  const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const heading = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }),
    content: { type: 'doc', content: [paragraph('Preface'), heading(1, 'Root'), heading(2, 'Child'), paragraph('Body'),
      heading(3, 'Nested'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('List body')] }] },
      heading(2, 'Sibling'), paragraph('Last body')] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    const cases = [ ['Preface', null], ['Root', ['Root', 1]], ['Body', ['Child', 2]],
      ['List body', ['Nested', 3]], ['Sibling', ['Sibling', 2]], ['Last body', ['Sibling', 2]] ];
    for (const [text, expected] of cases) {
      let pos;
      editor.state.doc.descendants((node, offset) => { if (node.isText && node.text === text) pos = offset; });
      editor.commands.setTextSelection(pos + 1);
      const selection = editor.state.selection.from;
      const section = editorState(editor).focusableSection;
      assert.deepEqual(section && [section.title, section.level], expected, text);
      assert.equal(execEditor(editor, 'focusCurrentSection'), expected !== null);
      const focused = editorState(editor);
      assert.equal(focused.focusedSectionId, section?.id ?? null);
      if (expected) {
        assert.equal(typeof focused.focusedSectionId, 'string');
        assert.ok(focused.focusedSectionPath.every(crumb => typeof crumb.id === 'string'));
      }
      assert.equal(editor.state.selection.from, selection, 'focusing from body retains the caret');
      editor.commands.showDocument();
    }
    // Shared hierarchy correction changes the heading levels consumed by state.
    editor.commands.setTextSelection(1);
    editor.commands.setHeading({ level: 6 });
    assert.equal(editorState(editor).focusableSection.level, 1);
  } finally { editor.destroy(); }
});

test('native outline hides folded descendants and headings outside focus, and navigation retains focus', async () => {
  const { editorOutline } = await import('../src/editor-host/commands.ts');
  const h = (level, text) => ({ type: 'heading', attrs: { level, 'data-toc-id': text }, content: [{ type: 'text', text }] });
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }),
    content: { type: 'doc', content: [h(1, 'Parent'), h(2, 'Child'), h(3, 'Grandchild'), h(1, 'Other')] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    execEditor(editor, 'fold', { id: 'Child' });
    assert.deepEqual(editorOutline(editor).map(h => [h.id, h.folded]), [['Parent', false], ['Child', true], ['Other', false]]);
    execEditor(editor, 'focusSection', { id: 'Parent' });
    assert.deepEqual(editorOutline(editor).map(h => h.id), ['Parent', 'Child']);
    const focused = editorState(editor).focusedSectionId;
    execEditor(editor, 'scrollToHeading', { id: 'Child' });
    assert.equal(editorState(editor).focusedSectionId, focused);
    execEditor(editor, 'unfold', { id: 'Child' });
    assert.deepEqual(editorOutline(editor).map(h => h.id), ['Parent', 'Child', 'Grandchild']);
  } finally { editor.destroy(); }
});

// Exercise the installed keymaps in their real priority order, without a DOM.
function pressBackspace(editor) {
  return editor.state.plugins.some(plugin => plugin.props.handleKeyDown?.(
    editor.view, { key: 'Backspace', keyCode: 8, preventDefault() {} },
  ));
}

test('Backspace at a heading start removes its format in place before joining rows', async t => {
  const { headingNumberingKey } = await import('../src/lib/heading-numbering.ts');
  const { getFoldedIds } = await import('../src/lib/heading-fold.ts');
  const p = text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
  const h = (text, level = 1) => ({ ...p(text), type: 'heading', attrs: { level, 'data-toc-id': text || null } });
  const makeEditor = (content, numbered) => {
    const editor = new Editor({ element: null,
      extensions: editorExtensions({ collaborative: false }),
      content: { type: 'doc', content } });
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    editor.view.dispatch(editor.state.tr.setMeta(headingNumberingKey, numbered));
    return editor;
  };
  for (const numbered of [false, true]) {
    for (const text of ['', 'Title']) {
      for (const above of [null, p(''), p('Previous'), h('Previous')]) {
        await t.test(`numbered=${numbered}, text=${JSON.stringify(text)}, above=${above?.type ?? 'none'}:${above?.content[0]?.text ?? ''}`, () => {
          const editor = makeEditor([...(above ? [above] : []), h(text), p('Body'), h('Next')], numbered);
          try {
            const position = above ? editor.state.doc.firstChild.nodeSize : 0;
            editor.commands.setTextSelection(position + 1);
            if (text) editor.commands.toggleFold(position);
            const before = editor.state.doc;
            assert.equal(pressBackspace(editor), true);
            assert.equal(editor.state.doc.childCount, before.childCount, 'keep the row');
            assert.equal(editor.state.doc.nodeAt(position).type.name, 'paragraph');
            assert.equal(editor.state.doc.nodeAt(position).textContent, text);
            assert.equal(editor.state.selection.from, position + 1);
            assert.equal(editor.state.selection.empty, true);
            assert.equal(editor.state.doc.child(above ? 2 : 1).textContent, 'Body');
            assert.deepEqual(getFoldedIds(editor.state), [], 'converted heading no longer hides its body');
            assert.equal(editor.commands.undo(), true);
            assert.ok(editor.state.doc.eq(before), 'one undo restores the heading and content');
            assert.deepEqual(getFoldedIds(editor.state), text ? [text] : [], 'undo restores the fold');
            assert.equal(pressBackspace(editor), true);
            if (above) {
              assert.equal(pressBackspace(editor), true);
              assert.equal(editor.state.doc.childCount, before.childCount - 1, 'second press joins normally');
            }
          } finally { editor.destroy(); }
        });
      }
    }
  }
  for (const container of ['blockquote', 'bulletList']) {
    await t.test(`heading inside ${container}`, () => {
      const content = container === 'blockquote'
        ? [{ type: container, content: [h('Title')] }]
        : [{ type: container, content: [{ type: 'listItem', content: [p('Item'), h('Title')] }] }];
      const editor = makeEditor(content, true);
      try {
        let position;
        editor.state.doc.descendants((node, pos) => { if (node.type.name === 'heading') position = pos; });
        editor.commands.setTextSelection(position + 1);
        const before = editor.state.doc;
        assert.equal(pressBackspace(editor), true);
        assert.equal(editor.state.doc.nodeAt(position).type.name, 'paragraph');
        assert.equal(editor.state.doc.nodeAt(position).textContent, 'Title');
        assert.equal(editor.state.selection.from, position + 1);
        assert.equal(editor.state.doc.firstChild.type.name, container);
        assert.equal(editor.commands.undo(), true);
        assert.ok(editor.state.doc.eq(before));
      } finally { editor.destroy(); }
    });
  }
  await t.test('hierarchy correction, middle caret and range selections', () => {
    const editor = makeEditor([h('Root'), h('Child', 2), h('Nested', 3)], true);
    try {
      editor.commands.setTextSelection(1);
      const before = editor.state.doc;
      assert.equal(pressBackspace(editor), true);
      assert.deepEqual(editor.getJSON().content.map(node => [node.type, node.attrs?.level]),
        [['paragraph', undefined], ['heading', 1], ['heading', 2], ['paragraph', undefined]]);
      assert.equal(editor.commands.undo(), true);
      assert.ok(editor.state.doc.eq(before), 'hierarchy correction shares the undo step');
      editor.commands.setTextSelection(3);
      assert.equal(pressBackspace(editor), false, 'middle caret falls through to native text deletion');
      assert.ok(editor.state.doc.eq(before));
      editor.commands.setTextSelection({ from: 1, to: 3 });
      assert.equal(pressBackspace(editor), true);
      assert.equal(editor.state.doc.firstChild.type.name, 'heading');
      assert.equal(editor.state.doc.firstChild.textContent, 'ot');
    } finally { editor.destroy(); }
  });
});
