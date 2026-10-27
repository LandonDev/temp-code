import { MessageSquarePlus } from "../chrome/icons";
import { useEffect, useMemo, useRef } from "react";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { TooltipProvider } from "../components/ui/tooltip";
import { LazyPopover } from "../chrome/menuRows";
import { type TranscriptSelection } from "../lib/transcriptSelection";

type Props = {
  selection: TranscriptSelection | null;
  onAddToChat: (text: string) => void;
  onDismiss: () => void;
};

/** Actions on text selected in a reply, floating above the selection. */
export function TranscriptSelectionMenu({ selection, onAddToChat, onDismiss }: Props) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Scrolling or resizing moves the text out from under the menu, so the
  // selection it acts on is gone; drop it rather than chase the range.
  // Escape drops the selection itself, not just the menu.
  useEffect(() => {
    if (!selection) return;
    const dismiss = () => onDismissRef.current();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      window.getSelection()?.removeAllRanges();
      dismiss();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [selection]);

  // The last selection keeps the toolbar whole while it fades out.
  const shown = useRef(selection);
  if (selection) shown.current = selection;
  const last = shown.current;
  const anchor = useMemo(() => (last ? { getBoundingClientRect: () => last.rect } : null), [last]);

  return (
    <LazyPopover
      anchor={anchor}
      open={!!selection}
      onOpenChange={(open) => {
        if (!open) onDismissRef.current();
      }}
      side="top"
      align="center"
      label="Selected text actions"
      initialFocus={false}
      finalFocus={false}
      className="w-auto flex-row gap-0.5 p-1"
    >
      {shown.current ? (
        <TooltipProvider>
          <div role="toolbar" aria-label="Selected text actions" className="flex items-center gap-0.5">
            <Tip label="Add to chat" side="top">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Add to chat"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (shown.current) onAddToChat(shown.current.text);
                  window.getSelection()?.removeAllRanges();
                  onDismiss();
                }}
              >
                <MessageSquarePlus />
              </Button>
            </Tip>
          </div>
        </TooltipProvider>
      ) : null}
    </LazyPopover>
  );
}
