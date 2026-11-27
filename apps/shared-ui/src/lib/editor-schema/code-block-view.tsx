import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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

function CopyCodeButton({ getText }: { getText: () => string }) {
  const [status, setStatus] = useState("");
  const feedback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(feedback.current);
    };
  }, []);

  async function copy() {
    let message = "Copied";
    try {
      await copyText(getText());
    } catch {
      message = "Copy failed";
    }
    if (!mounted.current) return;
    clearTimeout(feedback.current);
    setStatus(message);
    feedback.current = setTimeout(() => setStatus(""), 1800);
  }

  return (
    <>
      <IconTooltip label="Copy code">
        <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground"
          aria-label="Copy code" onMouseDown={event => event.preventDefault()} onClick={copy}>
          {status === "Copied" ? <Check /> : <Copy />}
        </Button>
      </IconTooltip>
      <span className="sr-only" role="status">{status}</span>
    </>
  );
}

export function codeBlockView(
  editor: Editor, node: Node, getPos: () => number | undefined, pre: HTMLElement, code: HTMLElement,
): NodeView {
  const dom = document.createElement("div");
  dom.className = "note-code-block";
  const toolbar = document.createElement("div");
  toolbar.className = "note-code-toolbar";
  toolbar.contentEditable = "false";
  const languageControl = document.createElement("div");
  languageControl.className = "note-code-language";
  const label = document.createElement("span");
  label.setAttribute("aria-hidden", "true");
  const picker = document.createElement("select");
  picker.setAttribute("aria-label", "Code language");
  picker.add(new Option("Plain text", ""));
  for (const [value, label] of Object.entries(codeLanguages)) picker.add(new Option(label, value));
  let current = node;
  let imported: HTMLOptionElement | undefined;

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
    label.textContent = picker.selectedOptions[0]?.text ?? "";
    picker.disabled = !editor.isEditable;
  };
  picker.addEventListener("change", () => {
    const pos = getPos();
    if (pos === undefined || !editor.isEditable) return;
    const { state, view } = editor;
    if (state.doc.nodeAt(pos) !== current) return;
    view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: picker.value || null }));
  });

  const copy = document.createElement("div");
  copy.className = "flex";
  const copyRoot = createRoot(copy);
  copyRoot.render(<CopyCodeButton getText={() => current.textContent} />);
  languageControl.append(label, picker);
  toolbar.append(languageControl, copy);
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
    destroy() { queueMicrotask(() => copyRoot.unmount()); },
  };
}
