import type { JSONContent } from "@tiptap/core";

export function markdownLabel(text: string) {
  return text.replace(/[\\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function escapeText(text: string) {
  // Leave Memnoter's ::, :::, ::list, ::block, ::end and {{cloze}} syntax intact.
  return text.replace(/[\\`*_\[\]<>~$!]/g, "\\$&")
    .replace(/^([ \t]*)([#>+-]|\d+[.)])(?=\s)/gm, (_, indent, marker: string) =>
      indent + marker.replace(/[.)#>+-]$/, "\\$&"))
    .replace(/^([ \t]*)([-=])(?=[-=]*[ \t]*$)/gm, "$1\\$2");
}

function destination(href: string) {
  return href.replace(/[\s()<>\\]/g, char => encodeURIComponent(char).replace(/\(/g, "%28").replace(/\)/g, "%29"));
}

function codeFence(text: string, minimum: number) {
  const longest = (text.match(/`+/g) ?? [])
    .reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(minimum, longest + 1));
}

export function jsonToMarkdown(doc: JSONContent, imagePath: (id: string) => string) {
  const children = (node: JSONContent) => node.content ?? [];
  const plain = (node: JSONContent): string => node.text ?? children(node).map(plain).join("");
  const inline = (node: JSONContent) => children(node).map(render).join("");
  const blocks = (node: JSONContent) => children(node).map(render).filter(Boolean).join("\n\n");

  function render(node: JSONContent): string {
    switch (node.type) {
      case "text": {
        const raw = node.text ?? "";
        let value = escapeText(raw);
        for (const mark of node.marks ?? []) {
          if (mark.type === "code") {
            const ticks = codeFence(raw, 1);
            const pad = /^`|`$/.test(raw) || (/^ .* $/.test(raw) && raw.trim()) ? " " : "";
            value = ticks + pad + raw + pad + ticks;
          } else if (raw.trim()) {
            const markers: Record<string, string> = { bold: "**", italic: "*", strike: "~~", highlight: "==" };
            const marker = markers[mark.type];
            if (marker) value = value.replace(/\S(?:[\s\S]*\S)?/, body => marker + body + marker);
            if (mark.type === "link" && typeof mark.attrs?.href === "string") {
              value = `[${value}](${destination(mark.attrs.href)})`;
            }
          }
        }
        return value;
      }
      case "heading":
        return "#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1))) + " " + inline(node).replace(/#+(?=[ \t]*$)/, hashes => hashes.replace(/#/g, "\\#"));
      case "paragraph":
      case "detailsSummary":
        return inline(node);
      case "mention":
        return "@reference";
      case "hardBreak":
        return "  \n";
      case "inlineMath":
        return `$${plain(node)}$`;
      case "mathBlock":
        return `${node.attrs?.cloze ? "**Cloze answer**\n\n" : ""}$$\n${plain(node)}\n$$`;
      case "horizontalRule":
        return "---";
      case "codeBlock":
      case "mermaidView": {
        const source = plain(node);
        const ticks = codeFence(source, 3);
        const language = node.type === "mermaidView" ? "mermaid" : typeof node.attrs?.language === "string"
          ? node.attrs.language.replace(/[^\w+-]/g, "") : "";
        return `${ticks}${language}\n${source}\n${ticks}`;
      }
      case "image":
      case "inlineImage": {
        const id: unknown = node.attrs?.fileId;
        const src: unknown = node.attrs?.src;
        const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
        const path = typeof id === "string" && id ? imagePath(id) : typeof src === "string" ? src : "";
        return path ? `![${markdownLabel(alt)}](${destination(path)})` : markdownLabel(alt);
      }
      case "orderedList":
      case "bulletList":
      case "taskList": {
        const start = Number(node.attrs?.start) || 1;
        return children(node).map((item, index) => {
          const prefix = node.type === "orderedList" ? `${start + index}. ` : "- ";
          const check = item.type === "taskItem" ? (item.attrs?.checked ? "[x] " : "[ ] ") : "";
          const [first = "", ...rest] = (check + blocks(item)).split("\n");
          return [prefix + first, ...rest.map(line => line ? " ".repeat(prefix.length) + line : "")].join("\n");
        }).join("\n");
      }
      case "blockquote":
      case "pdfTextQuote":
        return blocks(node).split("\n").map(line => line ? "> " + line : ">").join("\n");
      case "table": {
        const rows = children(node).map(row => children(row).map(cell =>
          blocks(cell).replace(/\|/g, "\\|").replace(/\n+/g, "<br>")));
        const [first, ...rest] = rows;
        if (!first?.length) return "";
        const row = (cells: string[]) => "| " + cells.join(" | ") + " |";
        return [row(first), row(first.map(() => "---")), ...rest.map(row)].join("\n");
      }
      default:
        return node.text ?? blocks(node);
    }
  }

  return blocks(doc);
}
