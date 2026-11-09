import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_CHUNK_BYTES, PDF_CHUNK_COMMAND } from '../src/editor-host/protocol.ts';

globalThis.window = {};
const { readNativePdf } = await import('../src/lib/native-pdf.ts');

function transport(reply) {
  const requests = [];
  window.webkit = { messageHandlers: { memnoter: { postMessage(message) {
    assert.equal(message.command, PDF_CHUNK_COMMAND);
    requests.push(message.args);
    queueMicrotask(() => {
      try { window.__memnoterBridge.resolve(message.id, reply(message.args)); }
      catch (error) { window.__memnoterBridge.reject(message.id, error.message); }
    });
  } } } };
  return requests;
}

test('native PDF reads exact bytes in bounded replies and stops on cancellation', async () => {
  const source = Buffer.alloc(PDF_CHUNK_BYTES + 19);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  const requests = transport(({ offset, length }) => ({ offset, total: source.length, data: source.subarray(offset, offset + length).toString('base64') }));
  assert.deepEqual(await readNativePdf('document', new AbortController().signal), new Uint8Array(source));
  assert.deepEqual(requests, [
    { documentId: 'document', offset: 0, length: PDF_CHUNK_BYTES },
    { documentId: 'document', offset: PDF_CHUNK_BYTES, length: PDF_CHUNK_BYTES },
  ]);
  const abort = new AbortController();
  const cancelled = transport(({ offset, length }) => {
    abort.abort();
    return { offset, total: source.length, data: source.subarray(offset, offset + length).toString('base64') };
  });
  await assert.rejects(readNativePdf('document', abort.signal), { name: 'AbortError' });
  assert.equal(cancelled.length, 1, 'closing the reader does not continue reading the rest of the PDF');
  await assert.rejects(readNativePdf('document', abort.signal), { name: 'AbortError' });
  assert.equal(cancelled.length, 1, 'an already cancelled reader makes no native call');
});

test('native PDF rejects invalid sizes, wrong offsets, truncated chunks and changing files', async () => {
  for (const reply of [
    null,
    { offset: 0, total: 0, data: '' },
    { offset: 0, total: 52428801, data: '' },
    { offset: 0, total: Infinity, data: '' },
    { offset: 1, total: 3, data: 'YWJj' },
    { offset: 0, total: 3, data: 'YQ==' },
    { offset: 0, total: 3, data: '!!!' },
  ]) {
    transport(() => reply);
    await assert.rejects(readNativePdf('document', new AbortController().signal));
  }
  transport(({ offset }) => ({ offset, total: offset ? PDF_CHUNK_BYTES + 20 : PDF_CHUNK_BYTES + 19,
    data: Buffer.alloc(offset ? 20 : PDF_CHUNK_BYTES).toString('base64') }));
  await assert.rejects(readNativePdf('document', new AbortController().signal), /invalid/);
});
