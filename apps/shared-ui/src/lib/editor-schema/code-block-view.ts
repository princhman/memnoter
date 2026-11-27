import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { codeLanguage, codeLanguages } from "./code-languages";

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Native WebViews can serve the editor from a custom scheme.
    }
  }
  let copied = false;
  const writePlainText = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData("text/plain", text);
    copied = true;
  };
  document.addEventListener("copy", writePlainText, true);
  try {
    if (!document.execCommand("copy") || !copied) throw new Error("Clipboard unavailable");
  } finally {
    document.removeEventListener("copy", writePlainText, true);
  }
}

export function codeBlockView(
  editor: Editor, node: Node, getPos: () => number | undefined, pre: HTMLElement, code: HTMLElement,
): NodeView {
  const dom = document.createElement("div");
  dom.className = "note-code-block";
  const toolbar = document.createElement("div");
  toolbar.className = "note-code-toolbar";
  toolbar.contentEditable = "false";
  const picker = document.createElement("select");
  picker.setAttribute("aria-label", "Code language");
  picker.add(new Option("Plain text", ""));
  for (const [value, label] of Object.entries(codeLanguages)) picker.add(new Option(label, value));
  let current = node;
  let imported: HTMLOptionElement | undefined;
  let feedback: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const displayLanguage = () => {
    const saved: unknown = current.attrs.language;
    const language = codeLanguage(saved);
    code.className = typeof saved === "string" && saved ? `language-${saved}` : "";
    imported?.remove();
    imported = undefined;
    if (!language && typeof saved === "string" && saved && !/^(text|plain|plaintext)$/i.test(saved)) {
      imported = new Option(saved, saved);
      picker.add(imported);
    }
    picker.value = language ?? imported?.value ?? "";
    picker.disabled = !editor.isEditable;
  };
  picker.addEventListener("change", () => {
    const pos = getPos();
    if (pos === undefined || !editor.isEditable) return;
    const { state, view } = editor;
    if (state.doc.nodeAt(pos) !== current) return;
    view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: picker.value || null }));
  });

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy code block");
  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  copy.addEventListener("mousedown", event => event.preventDefault());
  copy.addEventListener("click", async () => {
    let label = "Copied";
    try {
      await copyText(current.textContent);
    } catch {
      label = "Copy failed";
    }
    if (destroyed) return;
    clearTimeout(feedback);
    copy.textContent = label;
    status.textContent = label;
    feedback = setTimeout(() => {
      copy.textContent = "Copy";
      status.textContent = "";
    }, 1800);
  });
  toolbar.append(picker, copy, status);
  dom.append(toolbar, pre);
  displayLanguage();

  return {
    dom, contentDOM: code,
    update(next) {
      if (next.type !== current.type || next.attrs.language === "mermaid") return false;
      const changed = next.attrs.language !== current.attrs.language;
      current = next;
      if (changed) displayLanguage();
      return true;
    },
    stopEvent: event => event.target instanceof window.Node && toolbar.contains(event.target),
    ignoreMutation: mutation => mutation.type !== "selection" &&
      (toolbar.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === code)),
    destroy() { destroyed = true; clearTimeout(feedback); },
  };
}
