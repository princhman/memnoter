import { validMasks, type OcclusionFace } from "./occlusion.ts";

function validFace(value: unknown): value is OcclusionFace {
  if (!value || typeof value !== "object") return false;
  const face = value as OcclusionFace;
  if (face.version !== 1 || typeof face.revealed !== "boolean") return false;
  if (![face.fileId, face.imageId, face.targetMaskId].every(id => typeof id === "string" && id.length > 0)) return false;
  if (!Array.isArray(face.masks) || face.masks.length === 0) return false;
  const masks = validMasks(face.masks);
  return masks.length === face.masks.length && masks.some(mask => mask.id === face.targetMaskId);
}

// Stored JSON is untrusted even when its TypeScript type says otherwise.
// Admit both faces together: an invalid target must never render a bare image.
export function validatedOcclusionPair(front: unknown, back: unknown): [OcclusionFace, OcclusionFace] | null {
  if (!validFace(front) || !validFace(back) || front.revealed || !back.revealed) return null;
  if (front.fileId !== back.fileId || front.imageId !== back.imageId || front.targetMaskId !== back.targetMaskId) return null;
  if (JSON.stringify(front.masks) !== JSON.stringify(back.masks)) return null;
  return [front, back];
}
