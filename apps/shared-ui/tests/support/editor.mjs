import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { noteExtensions } from '../../src/lib/editor-schema.ts';

// Build the persisted schema without mounting a view or loading React.
export function editorExtensions({ collaborative = true } = {}) {
  return noteExtensions({ document: new Y.Doc() })
    .filter(extension => collaborative || extension.name !== 'collaboration')
    .map(extension => {
      if (collaborative) return extension;
      // Headless transactions use local undo history and keep the real schema;
      // outline DOM layout belongs to the browser suites.
      if (extension.name === 'starterKit') return extension.configure({ undoRedo: {} });
      if (extension.name === 'tableOfContents') return extension.extend({ onTransaction() {}, onDestroy() {}, addProseMirrorPlugins() { return []; } });
      return extension;
    });
}
export const schema = getSchema(editorExtensions());
