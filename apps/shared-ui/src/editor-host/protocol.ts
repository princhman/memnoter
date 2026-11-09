// Single source for the WKWebView wire contract. Generated Swift is checked in.
import type { FileType } from "../lib/content";
import type { ApplyResult } from "../lib/sync/apply-remote";
import type { ModuleView } from "../lib/store";
import type { Grade } from "../lib/fsrs";

export const BRIDGE_VERSION = 1;
export const FILE_SCHEME = "memnoter-file";
export const APP_SCHEME = "memnoter-app";
export const EDITOR_ENTRY = "editor.html";
export const REVIEW_ENTRY = "review-native.html";

// true means the command can run while content writes are paused.
export const EXEC_COMMANDS = {
  insertTable: false,
  addRowBefore: false,
  addRowAfter: false,
  addColumnBefore: false,
  addColumnAfter: false,
  deleteRow: false,
  deleteColumn: false,
  toggleHeaderRow: false,
  mergeCells: false,
  splitCell: false,
  deleteTable: false,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  highlight: false,
  setHighlight: false,
  removeHighlight: false,
  code: false,
  paragraph: false,
  heading: false,
  bulletList: false,
  orderedList: false,
  blockquote: false,
  inlineMath: false,
  mathBlock: false,
  link: false,
  undo: false,
  redo: false,
  makeCard: false,
  removeCard: false,
  joinClozes: false,
  codeBlock: false,
  insertSection: false,
  indent: false,
  outdent: false,
  foldCurrentSection: false,
  unfoldCurrentSection: false,
  focusCurrentSection: true,
  showDocument: true,
  insertImage: false,
  fold: false,
  unfold: false,
  focusSection: true,
  scrollToHeading: true,
  find: true,
} as const;
export type ExecCommand = keyof typeof EXEC_COMMANDS;

export interface Heading { id: string; level: number; text: string; pos: number; folded: boolean; number: string | null; }
export interface SectionCrumb { id: string; level: number; title: string; }
export interface FocusableSection { pos: number; id: string; title: string; level: number; }
export interface EditorState {
  focusableSection: FocusableSection | null;
  focusedSectionPath: SectionCrumb[];
  focusedSectionId: string | null;
  headingId: string | null;
  highlightColor: string | null;
  marks: string[];
  blockType: string;
  headingLevel: number | null;
  bulletList: boolean; orderedList: boolean; blockquote: boolean;
  inTable: boolean; canMergeCells: boolean; canSplitCell: boolean;
  canIndent: boolean; canOutdent: boolean;
  canMakeCard: boolean; inCloze: boolean; canJoinClozes: boolean;
  folded: boolean; canFold: boolean;
  canUndo: boolean; canRedo: boolean;
  hasSelection: boolean; editable: boolean; suppressKeyboard: boolean;
}
export interface NativeViewState {
  openedModuleId: string | null;
  viewByModule: Record<string, ModuleView>;
  sidebarOpen: boolean;
  recentModuleIds: string[];
  learnAhead: boolean;
}
// Includes the native -> web preference event so both ends share its name.
export interface NativeEvents {
  viewState: NativeViewState;
  cardsChanged: null;
  reviewState: ReviewState;
  "skip-cards-created-today": boolean;
  outline: { moduleId: string; headings: Heading[]; allHeadings: Heading[] };
  outlineCurrent: { moduleId: string; currentHeadingId: string | null };
  state: EditorState & { moduleId: string };
  ready: { protocolVersion: number };
  imagePreview: { open: boolean };
  error: { moduleId: string | null; message: string };
  saveStatus: { pending: number; failing: boolean; imageErrors: string[] };
  scrollDebug: { time: number; reason: string; [key: string]: unknown };
}
export type NativeEvent = { [K in keyof NativeEvents]: { kind: "event"; event: K; payload: NativeEvents[K] } }[keyof NativeEvents];
export interface EditorApi {
  applyRemote(result: ApplyResult): void;
  fileStored(moduleId: string, file: FileType): void;
  setBottomInset(px: number): void;
  setTopInset(px: number): void;
  revealCard(moduleId: string, cardId: string): void;
  open(moduleId: string): Promise<void>;
  flush(): Promise<void>;
  refreshModules(): Promise<void>;
  exec(command: ExecCommand, args?: Record<string, unknown>): boolean;
  setOutlineTracking(enabled: boolean): void;
  focus(): boolean;
}
export interface ReviewCountsState { new: number; learning: number; review: number; }
export interface ReviewState {
  counts: ReviewCountsState;
  laterToday: ReviewCountsState;
  countsLabel: string;
  currentKind: string | null;
  intervals: string[];
  canUndo: boolean;
  canRedo: boolean;
  revealed: boolean;
  busy: boolean;
  hasCard: boolean;
  canShowNow: boolean;
  loading: boolean;
  reviewed: number;
  moduleId: string | null;
  cardId: string | null;
  error: string | null;
}
export interface ReviewApi {
  load(scope: string | null): Promise<void>;
  reveal(): void;
  showNow(): void;
  rate(grade: Grade): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}
declare global {
  interface Window { memnoterEditor: EditorApi; memnoterReview: ReviewApi; }
}
