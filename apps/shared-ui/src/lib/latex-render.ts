// Render-time shorthand only; the editor and persisted source retain the input.
export function groupMathScripts(source: string): string {
  function commandEnd(start: number) {
    const name = /^[A-Za-z]+/.exec(source.slice(start + 1));
    return start + 1 + (name?.[0].length ?? 1);
  }

  function groupEnd(start: number) {
    let depth = 1;
    let end = start + 1;
    while (end < source.length && depth) {
      if (source[end] === "\\") end = commandEnd(end);
      else {
        if (source[end] === "{") depth++;
        if (source[end] === "}") depth--;
        end++;
      }
    }
    return depth === 0 ? end : -1;
  }

  let result = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      let end = commandEnd(index);
      // Text-mode contents have their own meaning for ^ and _.
      if (source.slice(index, end) === "\\text") {
        while (/\s/.test(source[end] ?? "") && end < source.length) end++;
        if (source[end] === "{") end = groupEnd(end);
        if (end < 0) end = source.length;
      }
      result += source.slice(index, end);
      index = end;
      continue;
    }
    result += char;
    index++;
    if (char !== "^" && char !== "_") continue;
    if (source[index] === "{") continue;

    const start = index;
    while (index < source.length && !/[\s}$&^_]/.test(source[index])) {
      if (source.startsWith("\\\\", index)) break;
      if (source[index] === "\\") index = commandEnd(index);
      else if (source[index] === "{") {
        const end = groupEnd(index);
        // Leave incomplete input to KaTeX rather than invent closing braces.
        if (end < 0) return result + source.slice(start);
        index = end;
      } else index++;
    }
    if (index > start) {
      const script = groupMathScripts(source.slice(start, index));
      result += Array.from(script).length === 1 ? script : `{${script}}`;
    }
  }
  return result;
}
