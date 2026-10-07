import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { htmlRenderPageUrl, type HtmlRenderReference } from "@shared/htmlRender";
import { X } from "../chrome/icons";
import { EASE_OUT, SPRING_PANEL } from "../lib/ease";
import { LAYER } from "../lib/layers";
import { HtmlRenderDocument } from "./HtmlRenderFrame";

/**
 * An agent's HTML page filling the window: the same sandboxed document with
 * the live theme, scrolling inside its frame. Built like the image lightbox
 * (module store, backdrop, Escape through the command map, corner X).
 */

let current: HtmlRenderReference | null = null;
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());
const subscribe = (f: () => void): (() => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function openHtmlRenderOverlay(reference: HtmlRenderReference): void {
  current = reference;
  emit();
}

export function closeHtmlRenderOverlay(): void {
  if (!current) return;
  current = null;
  emit();
}

/** The command map treats an open page like an open lightbox (Escape closes it). */
export function isHtmlRenderOverlayOpen(): boolean {
  return current !== null;
}

export function HtmlRenderOverlay() {
  const snap = useSyncExternalStore(subscribe, () => current);
  const reduce = useReducedMotion();
  return createPortal(
    <AnimatePresence>
      {snap ? (
        <motion.div
          data-html-render-overlay
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } }}
          className="fixed inset-0 flex items-center justify-center bg-black/40 p-8"
          style={{ zIndex: LAYER.dialog + 5 }}
          onClick={closeHtmlRenderOverlay}
        >
          <motion.div
            key={snap.pageId}
            initial={reduce ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1, transition: SPRING_PANEL }}
            className="flex size-full max-w-6xl flex-col overflow-hidden rounded-xl border border-content/10 bg-background-base shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-content/10 pl-4 pr-2">
              <span className="truncate font-sans text-[13px] text-content" title={snap.title}>
                {snap.title}
              </span>
              <button
                type="button"
                onClick={closeHtmlRenderOverlay}
                aria-label="Close page"
                className="pressable grid size-7 place-items-center rounded-md text-content/70 hover:bg-content/10 hover:text-content"
              >
                <X className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
            <HtmlRenderDocument
              src={htmlRenderPageUrl(snap)}
              title={snap.title}
              className="min-h-0 w-full flex-1"
            />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
