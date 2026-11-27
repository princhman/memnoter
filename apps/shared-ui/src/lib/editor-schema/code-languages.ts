const grammars = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  css: () => import("highlight.js/lib/languages/css"),
  html: () => import("highlight.js/lib/languages/xml"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
};

type Language = keyof typeof grammars;
export const codeLanguages: Record<Language, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  css: "CSS",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  python: "Python",
  rust: "Rust",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
};

const aliases = new Map<string, Language>([
  ["sh", "bash"], ["shell", "bash"], ["c++", "cpp"],
  ["xml", "html"], ["js", "javascript"], ["py", "python"],
  ["rs", "rust"], ["ts", "typescript"],
]);

const isLanguage = (value: string): value is Language => Object.prototype.hasOwnProperty.call(grammars, value);

export function codeLanguage(value: unknown): Language | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.toLowerCase();
  return isLanguage(name) ? name : aliases.get(name);
}

const loaded = new Map<Language, Promise<(source: string) => string>>();

export function loadGrammar(language: Language) {
  const existing = loaded.get(language);
  if (existing) return existing;
  const grammar = Promise.all([import("highlight.js/lib/core"), grammars[language]()])
    .then(([{ default: hljs }, { default: definition }]) => {
      hljs.registerLanguage(language, definition);
      return (source: string) => hljs.highlight(source, { language, ignoreIllegals: true }).value;
    });
  loaded.set(language, grammar);
  return grammar;
}
