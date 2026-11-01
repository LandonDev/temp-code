/**
 * "While it scrolls": the scrollbar rule in index.css shows a scroller's
 * thumb on hover or while the element carries `data-scrolling`. One
 * capture-phase listener on the document marks whichever element scrolled
 * and clears the mark SCROLL_IDLE_MS after its last scroll. No layout
 * reads, no React state; a burst writes the attribute once.
 */
import { SCROLL_IDLE_MS } from "./ease";

export const SCROLLING_ATTR = "data-scrolling";

export function installScrollActivity(doc: Document = document): () => void {
  // One pending clear per scrolling element; an entry lives only until it fires.
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();

  const onScroll = (event: Event) => {
    const el = event.target;
    // The document's own scroll (html and body never scroll) is not a scroller's.
    if (!(el instanceof Element) || el === doc.documentElement) return;
    if (!el.hasAttribute(SCROLLING_ATTR)) el.setAttribute(SCROLLING_ATTR, "");
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el);
        el.removeAttribute(SCROLLING_ATTR);
      }, SCROLL_IDLE_MS),
    );
  };

  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("scroll", onScroll, { capture: true });
    for (const [el, timer] of timers) {
      clearTimeout(timer);
      el.removeAttribute(SCROLLING_ATTR);
    }
    timers.clear();
  };
}
