import katex from "katex";
import { useState, type ReactNode } from "react";
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
  front: Segment[];
  back: Segment[];
  revealed: boolean;
}) {
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
