import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

export function PdfAnnotationPopover({ position, body, required, disabled, saving, persistenceError, onRetry, onSave, onDelete, onClose }: {
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
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement);
  useEffect(() => {
    host.current?.querySelector("textarea")?.focus({ preventScroll: true });
    return () => { const previous = returnFocus.current; if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
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
    <textarea aria-label={required ? "Comment" : "Comment (optional)"} placeholder={required ? "Add a comment" : "Add a comment (optional)"} className="min-h-20 w-full resize-y rounded bg-background p-2 text-foreground focus-visible:outline-2 focus-visible:outline-primary" value={value} onChange={event => setValue(event.target.value)} />
    <div className="mt-2 flex flex-wrap gap-1">
      <Button size="xs" disabled={disabled || (required && !value.trim())} onClick={() => attempt(() => onSave(value))}>Save</Button>
      {onDelete && <Button size="xs" variant="ghost" disabled={disabled} onClick={() => attempt(onDelete)}>Delete</Button>}
      <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
    </div>
    {saving && <p role="status">Saving annotations…</p>}
    {(error || persistenceError) && <p role="alert" className="mt-2 text-destructive">{error || persistenceError}</p>}
    {persistenceError && <Button size="xs" variant="ghost" disabled={disabled} onClick={() => attempt(onRetry)}>Retry saving</Button>}
  </div>;
}
