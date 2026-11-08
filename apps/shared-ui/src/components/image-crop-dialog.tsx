import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { HANDLES, moveBox, resizeBox, type Box, type Handle } from "@/lib/box";
import { Button } from "./ui/button";
export type Crop = Box;
const MIN_CROP = 0.05;

export function CropDialog({ image, onCancel, onSave }: {
  image: HTMLImageElement;
  onCancel: () => void;
  onSave: (crop: Crop) => Promise<void>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; crop: Crop; mode: "move" | Handle } | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, width: 1, height: 1 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, mode: "move" | Handle) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, crop, mode };
  };

  const updateDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    const bounds = frame.current?.getBoundingClientRect();
    if (!current || !bounds || current.pointerId !== event.pointerId) return;
    const dx = (event.clientX - current.startX) / bounds.width;
    const dy = (event.clientY - current.startY) / bounds.height;
    if (current.mode === "move") {
      setCrop(moveBox(current.crop, dx, dy));
    } else {
      setCrop(resizeBox(current.crop, current.mode, dx, dy, MIN_CROP));
    }
  };

  const endDrag = () => { drag.current = null; };

  const save = async () => {
    setSaving(true);
    setError("");
    try { await onSave(crop); } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the cropped image");
      setSaving(false);
    }
  };

  const area = { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` };
  const uncropped = crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      <DialogContent className="image-crop-dialog block sm:max-w-none" showCloseButton={false}>
        <DialogTitle>Crop image</DialogTitle>
        <p>Drag any edge or corner to crop, or drag inside the area to reposition it.</p>
        <div className="image-crop-preview">
          <div ref={frame} className="image-crop-frame">
            <img src={image.src} alt="Crop preview" draggable={false} />
            <div className="image-crop-shade-clip"><div className="image-crop-shade" style={area} /></div>
            <div className="image-crop-selection" style={area} onPointerDown={(event) => beginDrag(event, "move")} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
              {HANDLES.map((handle) => (
                <span key={handle} className={`image-crop-handle image-crop-handle-${handle}`} aria-label={`Resize crop area (${handle})`} onPointerDown={(event) => beginDrag(event, handle)} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
              ))}
            </div>
          </div>
        </div>
        {error && <p className="image-crop-error" role="alert">{error}</p>}
        <div className="image-crop-actions"><Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button><Button onClick={() => void save()} disabled={saving || uncropped}>{saving ? "Saving…" : "Apply crop"}</Button></div>
      </DialogContent>
    </Dialog>
  );
}

