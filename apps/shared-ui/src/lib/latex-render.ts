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

    // A script runs over letters, digits, commands (with their arguments) and
    // brace groups. Anything else — whitespace, operators, relations,
    // punctuation, `\\` — ends it, so `x^2+y^2` keeps its usual meaning.
    const start = index;
    while (index < source.length) {
      const c = source[index];
      if (/[A-Za-z0-9]/.test(c)) index++;
      else if (c === "\\" && /[A-Za-z{}$&_^#%]/.test(source[index + 1] ?? "")) {
        index = commandEnd(index);
        // Optional argument straight after a command, e.g. \sqrt[3]{x}.
        if (source[index] === "[") {
          const close = source.indexOf("]", index);
          if (close < 0) return result + source.slice(start);
          index = close + 1;
        }
      } else if (c === "{") {
        const end = groupEnd(index);
        // Leave incomplete input to KaTeX rather than invent closing braces.
        if (end < 0) return result + source.slice(start);
        index = end;
      } else break;
    }
    if (index > start) {
      const script = groupMathScripts(source.slice(start, index));
      result += Array.from(script).length === 1 ? script : `{${script}}`;
    }
  }
  return result;
}
