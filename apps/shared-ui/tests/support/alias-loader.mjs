const src = new URL('../../src/', import.meta.url);
export function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) specifier = new URL(`${specifier.slice(2)}${/\.[a-z]+$/.test(specifier) ? "" : ".ts"}`, src).href;
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
}
