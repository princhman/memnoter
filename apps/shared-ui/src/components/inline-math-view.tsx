import { type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { type Decoration } from "@tiptap/pm/view";
import "katex/dist/katex.min.css";
import { createViewportRenderer } from "@/lib/viewport-renderer";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { RemoveFormatting, Sigma } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MOD_KEY } from "@/lib/utils";

import { InlineMath, cleanMathText, renderKatex } from "@/lib/inline-math";
function PreviewAction({ label, hint, onClick, children }: {
  label: string;
  hint: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            // Keep the caret in the formula until the command runs.
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <span className="grid gap-0.5">
          <strong className="font-medium">{label}</strong>
          <span className="text-muted-foreground">{hint}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function PreviewActions({ editor }: { editor: Editor }) {
  return (
    <>
      <PreviewAction
        label="Convert to text"
        hint={`${MOD_KEY}Shift+M`}
        onClick={() => editor.chain().focus().toggleInlineMath().run()}
      >
        <RemoveFormatting />
      </PreviewAction>
      <PreviewAction
        label="Math block"
        hint={`${MOD_KEY}Alt+M`}
        onClick={() => editor.chain().focus().toggleMathBlock().run()}
      >
        <Sigma />
      </PreviewAction>
    </>
  );
}

export const InlineMathView = InlineMath.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      renderPreviewActions(element, editor) {
        const root = createRoot(element);
        flushSync(() => root.render(<PreviewActions editor={editor} />));
        return () => root.unmount();
      },
    };
  },
  addNodeView() {
    const deferRender = createViewportRenderer();
    return ({ node, decorations, getPos, editor }) => {
      const dom = document.createElement("span");
      dom.className = "inline-math";
      dom.dataset.type = "inline-math";
      const contentDOM = document.createElement("span");
      contentDOM.className = "inline-math-source";
      const rendered = document.createElement("span");
      rendered.className = "inline-math-widget";
      rendered.contentEditable = "false";
      dom.append(contentDOM, rendered);

      let currentNode = node;
      let renderedTex: string | undefined;
      let pendingTex: string | undefined;
      let cancelRender: (() => void) | undefined;
      let wasEditing: boolean | undefined;
      const renderNow = () => {
        cancelRender?.();
        cancelRender = undefined;
        pendingTex = undefined;
        const tex = cleanMathText(currentNode.textContent);
        if (tex.trim()) renderKatex(rendered, tex);
        else rendered.replaceChildren();
        rendered.removeAttribute("data-render-pending");
        renderedTex = tex;
      };
      const updateAppearance = (nextDecorations: readonly Decoration[]) => {
        const editing = nextDecorations.some(
          (decoration) => decoration.spec.mathEditing,
        );
        const selected = nextDecorations.some(
          (decoration) => decoration.spec.mathSelected,
        );
        if (editing !== wasEditing) {
          contentDOM.style.display = editing ? "" : "none";
          rendered.style.display = editing ? "none" : "";
          // Rendered formulas must not expose hidden source to caret movement.
          dom.contentEditable = editing ? "true" : "false";
          wasEditing = editing;
        }
        const tex = cleanMathText(currentNode.textContent);
        rendered.classList.toggle("is-empty", !tex.trim());
        rendered.classList.toggle("is-selected", selected);
        if (editing) {
          cancelRender?.();
          cancelRender = undefined;
          pendingTex = undefined;
        } else if (tex !== renderedTex) {
          if (selected || !tex.trim()) {
            renderNow();
          } else if (tex !== pendingTex) {
            cancelRender?.();
            // The real source stays in contentDOM. This lightweight preview
            // keeps off-screen formulas usable before their KaTeX DOM exists.
            rendered.textContent = tex;
            rendered.setAttribute("data-render-pending", "");
            renderedTex = undefined;
            pendingTex = tex;
            cancelRender = deferRender(rendered, renderNow);
          }
        }
      };

      rendered.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (pendingTex !== undefined) renderNow();
        const pos = getPos();
        if (typeof pos !== "number") return;
        const rect = rendered.getBoundingClientRect();
        const edge = Math.min(6, rect.width / 4);
        // Rendered math and LaTeX have different widths. Map the click's
        // relative position to a source character boundary before revealing it.
        const fraction = Math.max(0, Math.min(1,
          (event.clientX - rect.left) / (rect.width || 1),
        ));
        const characters = Array.from(currentNode.textContent);
        const offset = characters
          .slice(0, Math.round(fraction * characters.length))
          .join("").length;
        // The outer edges place the caret in surrounding text; the middle edits.
        const target =
          event.clientX <= rect.left + edge
            ? pos
            : event.clientX >= rect.right - edge
              ? pos + currentNode.nodeSize
              : pos + 1 + offset;
        const { view } = editor;
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, target)),
        );
        view.focus();
      });

      updateAppearance(decorations);
      return {
        dom,
        contentDOM,
        destroy() {
          cancelRender?.();
        },
        update(nextNode, nextDecorations) {
          if (nextNode.type !== currentNode.type) return false;
          currentNode = nextNode;
          updateAppearance(nextDecorations);
          return true;
        },
        setSelection(anchor, head) {
          const pos = getPos();
          if (typeof pos !== "number") return;
          const selection = dom.ownerDocument.getSelection();
          if (!selection) return;
          const from = editor.view.domAtPos(pos + 1 + anchor);
          const to = editor.view.domAtPos(pos + 1 + head);
          // WebKit can consider the outer boundary equivalent to offset zero
          // inside the source. Explicitly enter the editable text in both cases.
          selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
        },
        stopEvent: (event) =>
          event.target instanceof window.Node && rendered.contains(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" &&
          (rendered.contains(mutation.target) ||
            (mutation.type === "attributes" && mutation.target === contentDOM)),
      };
    };
  },

});
