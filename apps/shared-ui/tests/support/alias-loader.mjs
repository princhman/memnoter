const src = new URL('../../src/', import.meta.url);
export function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) specifier = new URL(`${specifier.slice(2)}.ts`, src).href;
  return next(specifier, context);
}
