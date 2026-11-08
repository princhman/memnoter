import { useEffect, useRef, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import type { PdfAnnotationColor } from "@/lib/pdf-annotations";
import { PdfHighlightColors } from "./pdf-highlight-colors";
import { Button } from "./ui/button";
import { ToolButton } from "./ui/tool-button";

export function PdfAnnotationPopover({ position, body, required, disabled, saving, persistenceError, onRetry, onSave, onDelete, onClose, color, onColorChange }: {
  color: PdfAnnotationColor;
  onColorChange?: (color: PdfAnnotationColor) => void;
  position: { left: number; top: number };
  body: string;
  required: boolean;
  disabled: boolean;
  saving: boolean;
  persistenceError: string | null;
  onRetry: () => void;
  onSave: (body: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(body);
  const canSave = value !== body && (!required || !!value.trim());
  const [commenting, setCommenting] = useState(required || !!body);
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement);
  const restoreFocus = useRef(true);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    (host.current?.querySelector("textarea") ?? host.current?.querySelector("button"))?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || host.current?.contains(event.target)) return;
      restoreFocus.current = false;
      close.current();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      const previous = returnFocus.current;
      if (restoreFocus.current && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const attempt = (fn: () => void) => { try { fn(); setError(""); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } };
  return <div ref={host} role="dialog" aria-label="PDF annotation" className="absolute z-40 w-64 max-w-[calc(100%-1rem)] rounded-lg floating-surface p-2 text-xs shadow-lg" style={position} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Tab") {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),textarea:not(:disabled)"));
      const next = event.shiftKey ? controls[controls.length - 1] : controls[0];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls[controls.length - 1])) { event.preventDefault(); next?.focus(); }
    }
  }}>
    {onColorChange && <div className="mb-2"><PdfHighlightColors color={color} disabled={disabled} onChange={color => attempt(() => onColorChange(color))} /></div>}
    {commenting && <textarea autoFocus aria-label={required ? "Comment" : "Comment (optional)"} placeholder={required ? "Add a comment" : "Add a comment (optional)"} className="min-h-20 w-full resize-y rounded bg-background p-2 text-foreground focus-visible:outline-2 focus-visible:outline-primary" value={value} onChange={event => setValue(event.target.value)} />}
    <div className="mt-2 flex items-center gap-1">
      {onDelete && <ToolButton size="icon-xs" label="Delete annotation" className="text-muted-foreground hover:text-destructive" disabled={disabled} onClick={() => attempt(onDelete)}><Trash2 /></ToolButton>}
      {!commenting && <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setCommenting(true)}><MessageSquare aria-hidden="true" />Add comment</Button>}
      {commenting && <Button size="xs" className="ml-auto" variant={canSave ? "default" : "secondary"} disabled={disabled || !canSave} onClick={() => attempt(() => onSave(value))}>Save</Button>}
    </div>
    {saving && <p role="status">Saving annotations…</p>}
    {(error || persistenceError) && <p role="alert" className="mt-2 text-destructive">{error || persistenceError}</p>}
    {persistenceError && <Button size="xs" variant="ghost" disabled={disabled} onClick={() => attempt(onRetry)}>Retry saving</Button>}
  </div>;
}
