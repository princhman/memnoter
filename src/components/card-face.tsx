import katex from "katex";
import { validatedOcclusionPair } from "@/lib/occlusion-face-validation";
import { useEffect, useState, type ReactNode } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { MaskShape } from "@/components/occlusion-editor";
import { validMasks, type OcclusionFace } from "@/lib/occlusion";
import type { CardKind, Segment, CardPayload } from "@/lib/cards";
import { cn } from "@/lib/utils";

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
  const text = "card-face whitespace-pre-wrap text-xl leading-relaxed";
  switch (kind) {
    case "basic":
      return (
        <div className="grid gap-6">
          <div className={text}>
            <Segments segments={front} />
          </div>
          {revealed && (
            <>
              <hr className="border-border" />
              <div className={text}>
                <Segments segments={back} />
              </div>
            </>
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
  useEffect(() => {
    let active = true;
    void invoke<string>("resolve_card_image", { fileId: face.fileId }).then(path => {
      if (active) setAsset({ fileId: face.fileId, src: convertFileSrc(path) });
    }).catch(() => { if (active) setAsset({ fileId: face.fileId, failed: true }); });
    return () => { active = false; };
  }, [face.fileId]);
  if (asset?.fileId !== face.fileId) return <p role="status">Loading image…</p>;
  if (asset.failed || face.version !== 1) return <p role="alert">Image unavailable. Open the source note to check or remove the image.</p>;
  const target = validMasks(face.masks).find(m => m.id === face.targetMaskId);
  return <div className="grid gap-3"><p>{face.revealed ? "Answer outlined below" : "Recall the covered area"}</p><div className="occlusion-frame">
    <img src={asset.src} alt="Occlusion review image" onError={() => setAsset({ fileId: face.fileId, failed: true })} />
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label={face.revealed ? "Target answer outlined" : "Target answer hidden"}>
      {target && <MaskShape mask={target} fill={face.revealed ? "none" : "#557bcd"} stroke="#e9a23b" strokeWidth={0.006} />}
    </svg>
  </div></div>;
}
