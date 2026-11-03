import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { HeadingFold } from '../src/lib/heading-fold.ts';
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
