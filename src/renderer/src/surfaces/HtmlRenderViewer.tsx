import { useRef, useSyncExternalStore } from "react";
import { htmlRenderPageUrl } from "@shared/htmlRender";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { X } from "../chrome/icons";
import { assetHref } from "../lib/nativeWeb";
import { HtmlRenderDocument } from "./HtmlRenderFrame";
import { closeHtmlRenderOverlay, htmlRenderOverlaySnapshot, subscribeHtmlRenderOverlay } from "./htmlRenderOverlayStore";

/**
 * An agent's HTML page filling the window: the same sandboxed document with
 * the live theme, scrolling inside its frame. The lightbox's frame (a
 * full-window Dialog on a module store, Escape through the command map, or
 * from the page's own script while focus is inside it), with one close
 * button over the page that holds focus when it opens.
 */
export function HtmlRenderViewer() {
  const snap = useSyncExternalStore(subscribeHtmlRenderOverlay, htmlRenderOverlaySnapshot);
  // The last open page stays rendered while the exit plays.
  const last = useRef(snap);
  const close = useRef<HTMLButtonElement>(null);
  if (snap) last.current = snap;
  const shown = snap ?? last.current;
  if (!shown) return null;
  return (
    <Dialog
      open={!!snap}
      onOpenChange={(open) => {
        if (!open) closeHtmlRenderOverlay();
      }}
    >
      <DialogContent
        size="full"
        showCloseButton={false}
        initialFocus={close}
        data-html-render-overlay
        className="flex flex-col gap-0 overflow-hidden rounded-2xl bg-background p-0 shadow-overlay ring-1 ring-border"
      >
        <DialogTitle className="sr-only">{shown.reference.title}</DialogTitle>
        <HtmlRenderDocument
          key={shown.reference.pageId}
          src={assetHref(htmlRenderPageUrl(shown.reference, shown.host))}
          title={shown.reference.title}
          className="min-h-0 w-full flex-1"
          onEscape={closeHtmlRenderOverlay}
        />
        <DialogClose
          ref={close}
          aria-label="Close page"
          render={<Button variant="secondary" size="icon-sm" className="absolute end-3 top-3" />}
        >
          <X />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
