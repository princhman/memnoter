import katex from "katex";
import type { ReactNode } from "react";
import type { CardKind, Segment } from "@/lib/cards";
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
  front: Segment[];
  back: Segment[];
  revealed: boolean;
}) {
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
