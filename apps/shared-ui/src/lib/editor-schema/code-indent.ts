export function codeIndentUnit(source: string) {
  let spaces = Infinity;
  for (const line of source.split("\n")) {
    const indent = line.match(/^[ \t]+(?=\S)/)?.[0];
    if (!indent) continue;
    if (indent.startsWith("\t")) return "\t";
    spaces = Math.min(spaces, indent.length);
  }
  return " ".repeat(Number.isFinite(spaces) ? spaces : 4);
}
