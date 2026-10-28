// search_notes wraps each match in these control characters rather than HTML,
// so note text can never be rendered as markup.
const MARK_START = "\u0002";
const MARK_END = "\u0003";

export type MarkedSegment = { text: string; marked: boolean };

export function splitMarked(text: string): MarkedSegment[] {
  const segments: MarkedSegment[] = [];
  let marked = false;
  let current = "";
  const push = () => {
    if (current) segments.push({ text: current, marked });
    current = "";
  };
  for (const char of text) {
    if (char === MARK_START || char === MARK_END) {
      push();
      marked = char === MARK_START;
    } else {
      current += char;
    }
  }
  push();
  return segments;
}

// What the find bar should look for after opening a search result, best first:
// the whole query, then the note's own spelling of each match (the index folds
// accents, the find bar does not), then each query word, longest first.
export function findTermsFor(query: string, snippet: string) {
  const matches = splitMarked(snippet)
    .filter((segment) => segment.marked)
    .map((segment) => segment.text);
  const words = query.split(/\s+/).filter(Boolean);
  const longestFirst = [...words].sort((a, b) => b.length - a.length);
  const terms = [words.join(" "), ...matches, ...longestFirst]
    .map((term) => term.trim())
    .filter(Boolean);
  return [...new Set(terms)];
}
