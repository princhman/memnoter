import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { HeadingFold } from '../src/lib/heading-fold.ts';
import { SectionFocus, sectionFocusKey } from '../src/lib/section-focus.ts';
import { HeadingHieararchy } from '../src/lib/heading-hierarchy.ts';
import { Flashcards } from '../src/lib/flashcards.ts';
import { execEditor, editorState } from '../src/editor-host/commands.ts';

function createEditor() {
  const editor = new Editor({ element: null, extensions: [StarterKit, Flashcards, HeadingFold],
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
    for (const level of [1, 2, 3]) {
      assert.equal(execEditor(editor, 'heading', { level }), true);
      assert.equal(editorState(editor).headingLevel, level);
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
  const editor = new Editor({ element: null, extensions: [StarterKit, Flashcards, HeadingFold, SectionFocus, HeadingHieararchy],
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
      assert.equal(sectionFocusKey.getState(editor.state), section?.pos ?? null);
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
  const HeadingIds = (await import('@tiptap/core')).Extension.create({
    name: 'outlineIds',
    addGlobalAttributes() { return [{ types: ['heading'], attributes: { 'data-toc-id': { default: null } } }]; },
  });
  const h = (level, text) => ({ type: 'heading', attrs: { level, 'data-toc-id': text }, content: [{ type: 'text', text }] });
  const editor = new Editor({ element: null, extensions: [StarterKit, HeadingIds, HeadingFold, SectionFocus],
    content: { type: 'doc', content: [h(1, 'Parent'), h(2, 'Child'), h(3, 'Grandchild'), h(1, 'Other')] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    execEditor(editor, 'fold', { id: 'Child' });
    assert.deepEqual(editorOutline(editor).map(h => [h.id, h.folded]), [['Parent', false], ['Child', true], ['Other', false]]);
    execEditor(editor, 'focusSection', { id: 'Parent' });
    assert.deepEqual(editorOutline(editor).map(h => h.id), ['Parent', 'Child']);
    const focused = sectionFocusKey.getState(editor.state);
    execEditor(editor, 'scrollToHeading', { id: 'Child' });
    assert.equal(sectionFocusKey.getState(editor.state), focused);
    execEditor(editor, 'unfold', { id: 'Child' });
    assert.deepEqual(editorOutline(editor).map(h => h.id), ['Parent', 'Child', 'Grandchild']);
  } finally { editor.destroy(); }
});
