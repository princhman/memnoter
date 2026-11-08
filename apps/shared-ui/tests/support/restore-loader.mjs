const root = new URL('../../src/', import.meta.url).href;
import ts from 'typescript';
export function resolve(specifier, context, next) {
  if (specifier.endsWith('/sync/manager.ts')) return next(specifier, context);
  if (context.parentURL?.endsWith('/sync/manager.ts')) {
    const modules = {
      './apply-remote.ts': 'export const onRemote = () => {}; export const onFileStored = () => {}; export const cancelRemoteReindex = () => {}; export const drainRemoteReindex = async () => {};',
      './engine': `import { createSyncEngine as real } from '${root}lib/sync/engine.ts'; export const createSyncEngine = (...args) => globalThis.syncFixture.engine ? globalThis.syncFixture.engine(...args) : real(...args);`,
      './files': `import { createFileSync as real } from '${root}lib/sync/files.ts'; export const createFileSync = (...args) => globalThis.syncFixture.files ? globalThis.syncFixture.files(...args) : real(...args);`,
      './crypto': `import { importKey as real } from '${root}lib/sync/crypto.ts'; export const importKey = (...args) => globalThis.syncFixture.engine ? Promise.resolve({}) : real(...args);`,
      '@/lib/backend': 'export const call = (...a) => globalThis.syncFixture.call(...a); export const listen = async () => () => {};',
      '@/lib/write-lifecycle': 'export const exclusiveWrite = async fn => fn(); export const assertWritable = () => {};',
      '@/lib/saves': 'export const saveQueue = { clear() {}, isSuspended: () => false };',
      '@/lib/content': 'export const acknowledgeContent = () => {};',
      '@/lib/card-sync': 'export const dueCountsKey = []; export const isModuleOpen = () => false;',
      '@/lib/card-backfill': 'export const reindexStoredCards = async () => {};',
      '@/lib/query-client': 'export const queryClient = {};',
      '@/lib/search-index': 'export const indexStoredNote = async () => {};',
      '@/lib/store': 'export const forgetModule = () => {};',
      './file-requests': 'export const setSyncedFileHandler = fn => globalThis.requestFile = fn; export const syncedFileArrived = () => {};',
    };
    if (modules[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
    if (specifier === './protocol') return next(root + 'lib/sync/protocol.ts', context);
  }
  if (specifier === '@/lib/backend') return { url: 'data:text/javascript,' + encodeURIComponent('export const call = (...a) => globalThis.syncFixture.call(...a);'), shortCircuit: true };
  if (context.parentURL?.includes('/lib/sync/') && specifier.startsWith('./')) return next(new URL(specifier + '.ts', context.parentURL).href, context);
  return next(specifier, context);
}
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.endsWith('.ts')) return { ...result, format: 'module', source: ts.transpileModule(result.source.toString().replaceAll('import.meta.env.', '({}).'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  return result;
}
