import type { ComponentProps, ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ImagePreview } from "@/components/image-preview";

type ContentProps = ComponentProps<typeof DropdownMenuContent>;

/** The round "…" button and menu shared by note images and question crops. */
export function ImageActionsMenu({ label, finalFocus, className, children }: {
  label: string;
  finalFocus?: ContentProps["finalFocus"];
  className?: string;
  children: ReactNode;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="note-image-menu-button" aria-label={label} />}><Ellipsis /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={className ?? "w-60"} finalFocus={finalFocus}>{children}</DropdownMenuContent>
  </DropdownMenu>;
}

/** Full-screen image viewer opened from "Open image full screen". */
export function ImagePreviewDialog({ open, onOpenChange, src, alt, finalFocus, contentRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string | undefined;
  alt: string;
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
  contentRef?: ComponentProps<typeof DialogContent>["ref"];
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent ref={contentRef} className="image-preview-dialog h-dvh max-w-none overflow-hidden rounded-none p-4 pt-12 sm:max-w-none" finalFocus={finalFocus}>
      <DialogTitle className="sr-only">Image preview</DialogTitle>
      <ImagePreview src={src} alt={alt} />
    </DialogContent>
  </Dialog>;
}
