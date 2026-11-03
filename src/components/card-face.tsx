import katex from "katex";
import { validatedOcclusionPair } from "@/lib/occlusion-face-validation";
import { useEffect, useState, type ReactNode } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { MaskShape } from "@/components/occlusion-editor";
import { targetsOf, validMasks, type OcclusionFace } from "@/lib/occlusion";
import type { CardKind, Segment, CardPayload } from "@/lib/cards";
import { cn } from "@/lib/utils";
import { useSelector } from "@tanstack/react-store";
import { requestSyncedFile, syncedFilesStore } from "@/lib/sync/file-requests";

const MARK_TAGS: Record<string, keyof HTMLElementTagNameMap> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  code: "code",
  highlight: "mark",
};

function TexMath({ tex }: { tex: string }) {
  const html = katex.renderToString(tex, { throwOnError: false });
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

// Another cloze of the card's text: hidden like the one asked, but a click
// shows it, and hides it again, without showing the answer.
function HiddenCloze({ children }: { children: Segment[] }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={shown}
      aria-label={shown ? undefined : "Show this cloze"}
      className="mx-0.5 inline-block min-w-12 cursor-pointer rounded-md bg-muted px-2 text-center text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      // Keep focus off it, so Space still shows the answer.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setShown((value) => !value)}
    >
      {shown ? <Segments segments={children} /> : "[…]"}
    </button>
  );
}

function Segments({ segments }: { segments: Segment[] }) {
  return segments.map((segment, index) => {
    switch (segment.type) {
      case "math":
        return <TexMath key={index} tex={segment.tex} />;
      case "break":
        return <br key={index} />;
      case "blank":
        return (
          <span
            key={index}
            className="mx-0.5 inline-block min-w-12 rounded-md bg-primary/10 px-2 text-center text-primary"
          >
            […]
          </span>
        );
      case "hidden":
        return <HiddenCloze key={index}>{segment.children}</HiddenCloze>;
      case "cloze":
        return (
          <span key={index} className="rounded-md bg-primary/10 px-1 font-medium text-primary">
            <Segments segments={segment.children} />
          </span>
        );
      case "text": {
        let node: ReactNode = segment.text;
        for (const mark of segment.marks ?? []) {
          const Tag = MARK_TAGS[mark];
          if (Tag) node = <Tag>{node}</Tag>;
        }
        return <span key={index}>{node}</span>;
      }
    }
  });
}

// Renders one side of a card. Each kind decides what its front and back hold;
// image occlusion adds its own case here.
export function CardFace({
  kind,
  front,
  back,
  revealed,
}: {
  kind: CardKind;
  front: CardPayload;
  back: CardPayload;
  revealed: boolean;
}) {
  if (kind === "occlusion") {
    const pair = validatedOcclusionPair(front, back);
    if (!pair) return <p role="alert">This image card has invalid masks. Open its note to repair it.</p>;
    return <OcclusionReview face={pair[revealed ? 1 : 0]} />;
  }
  if (!Array.isArray(front) || !Array.isArray(back)) return <p role="alert">This card has an unsupported payload. Open its note to repair it.</p>;
  const text = "card-face min-w-0 whitespace-pre-wrap break-words text-xl leading-relaxed sm:text-2xl";
  switch (kind) {
    case "basic":
      return (
        <div className="grid gap-7">
          <div className="grid gap-3">
            <div className={text}>
              <Segments segments={front} />
            </div>
          </div>
          {revealed && (
            <div className="grid gap-7">
              <hr className="mx-auto w-1/3 border-border/70" />
              <div className={text}>
                <Segments segments={back} />
              </div>
            </div>
          )}
        </div>
      );
    case "cloze":
      return (
        <div className={text}>
          <Segments segments={revealed ? back : front} />
        </div>
      );
    default:
      return (
        <div className={cn(text, "text-muted-foreground")}>
          This card type is not supported yet.
        </div>
      );
  }
}

function OcclusionReview({ face }: { face: OcclusionFace }) {
  const [asset, setAsset] = useState<{ fileId: string; src?: string; failed?: boolean }>();
  // An image from another device may still be downloading; look again when one arrives.
  const syncedFiles = useSelector(syncedFilesStore, (state) => state.version);
  useEffect(() => {
    let active = true;
    void invoke<string>("resolve_card_image", { fileId: face.fileId }).then(path => {
      if (active) setAsset({ fileId: face.fileId, src: convertFileSrc(path) });
    }).catch(() => {
      if (!active) return;
      setAsset({ fileId: face.fileId, failed: true });
      requestSyncedFile(face.fileId);
    });
    return () => { active = false; };
  }, [face.fileId, syncedFiles]);
  if (asset?.fileId !== face.fileId) return <p role="status">Loading image…</p>;
  if (asset.failed || face.version !== 1) return <p role="alert">Image unavailable. Open the source note to check or remove the image.</p>;
  return <OcclusionImage face={face} src={asset.src!} onError={() => setAsset({ fileId: face.fileId, failed: true })} />;
}

// The asked masks cover their answer until it is shown, then are outlined.
// The other masks stay covered too, and a click shows or covers one, for
// context; once the answer is shown they are all uncovered.
function OcclusionImage({ face, src, onError }: { face: OcclusionFace; src: string; onError: () => void }) {
  const [peeked, setPeeked] = useState<Set<string>>(new Set());
  const targets = new Set(targetsOf(face));
  const masks = validMasks(face.masks);
  const toggle = (id: string) => setPeeked(current => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return <div className="occlusion-frame">
    <img src={src} alt="Occlusion review image" onError={onError} />
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label={face.revealed ? "Answer outlined" : "Answer hidden"}>
      {masks.map(mask => targets.has(mask.id)
        ? <MaskShape key={mask.id} mask={mask} className={face.revealed ? "occlusion-answer" : "occlusion-target"} vectorEffect="non-scaling-stroke" />
        : !face.revealed && <MaskShape
            key={mask.id}
            mask={mask}
            role="button"
            aria-label={peeked.has(mask.id) ? "Cover this area" : "Show this area"}
            className={cn("occlusion-other", peeked.has(mask.id) && "is-peeked")}
            vectorEffect="non-scaling-stroke"
            onClick={() => toggle(mask.id)}
          />)}
    </svg>
  </div>;
}
