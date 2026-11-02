import { MessageSquarePlus } from "../chrome/icons";
import { useEffect, useMemo, useRef } from "react";
import { Button } from "../components/ui/button";
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
      className="w-auto flex-row p-1"
    >
      {shown.current ? (
        <div role="toolbar" aria-label="Selected text actions" className="flex items-center gap-0.5">
          {/* The popover's 12px corner less its 4px inset: the button's 8px. */}
          <Button
            variant="ghost"
            size="xs"
            className="rounded-lg text-[13px]"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (shown.current) onAddToChat(shown.current.text);
              window.getSelection()?.removeAllRanges();
              onDismiss();
            }}
          >
            <MessageSquarePlus className="size-3.5" />
            Add to chat
          </Button>
        </div>
      ) : null}
    </LazyPopover>
  );
}
