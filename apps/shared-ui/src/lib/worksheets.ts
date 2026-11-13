import * as Y from "yjs";

// Read/preserve release only. No constructor or mutation command is exported.
export const WORKSHEET_ROOT = "worksheets";
export const WORKSHEET_SCHEMA_VERSION = 1;
export type WorksheetInkRevision = { sourceId: string; previewId: string };
export type WorksheetPart = { parentId: string | null; order: number; label: string; cropIds: string[] };
export type WorksheetCrop = {
  partId: string; assetId: string; sourcePdfFileId: string; pageIndex: number;
  rect: [number, number, number, number]; rotation: 0 | 90 | 180 | 270; pixelSize: [number, number];
};
export type WorksheetRevision = { questionId: string; rootPartId: string; parts: Record<string, WorksheetPart>; crops: Record<string, WorksheetCrop> };
export type WorksheetPin = { questionId: string; revisionId: string };
export type WorksheetAnswer = {
  attemptId: string; revisionId: string; leafPartId: string; text: Y.XmlFragment;
  canvasOrder: string[]; canvases: Record<string, {
    width: number; height: number; revision: WorksheetInkRevision | null; copies: WorksheetInkRevision[];
  }>;
};

// A root unknown to this build must not enter an editor or asset collector.
// Worksheet documents are also read-only until the authoring release. Checking
// doc.share avoids creating roots just by opening a legacy module.
export function hasReadOnlyModuleRoots(doc: Y.Doc): boolean {
  return [...doc.share.keys()].some(name => name !== "default");
}
