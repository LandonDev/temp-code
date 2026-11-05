/**
 * "While it scrolls": the scrollbar rule in index.css shows a scroller's
 * thumb on hover or while the element carries `data-scrolling`. One
 * capture-phase listener on the document marks whichever element scrolled
 * and clears the mark SCROLL_IDLE_MS after its last scroll. No layout
 * reads, no React state; a burst writes the attribute once.
 *
 * Its hover rests meanwhile: the same listener marks it `data-scroll-quiet`
 * and index.css takes the pointer off its children, so rows sliding under a
 * still pointer turn no hover on and off (each a style pass over the row, a
 * hover transition started and cancelled, pointer events through React).
 * That mark clears SCROLL_QUIET_MS after the last scroll, or at once when
 * the person moves the pointer (the browser's own move after a scroll
 * carries no movement) or presses a button; a scroll with a button held (a
 * scrollbar drag, a selection or a drag reaching the edge) never sets it,
 * since those read the element under the pointer.
 */
import { SCROLL_IDLE_MS, SCROLL_QUIET_MS } from "./ease";

export const SCROLLING_ATTR = "data-scrolling";
export const QUIET_ATTR = "data-scroll-quiet";

export function installScrollActivity(doc: Document = document): () => void {
  // One pending clear per scrolling element and mark; an entry lives only until it fires.
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const quiet = new Map<Element, ReturnType<typeof setTimeout>>();
  const rest = (el: Element) => {
    clearTimeout(quiet.get(el));
    quiet.delete(el);
    el.removeAttribute(QUIET_ATTR);
  };
  const restAll = () => {
    for (const el of [...quiet.keys()]) rest(el);
  };
  let pressed = false;

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
    if (pressed) return;
    if (!el.hasAttribute(QUIET_ATTR)) el.setAttribute(QUIET_ATTR, "");
    clearTimeout(quiet.get(el));
    quiet.set(
      el,
      setTimeout(() => rest(el), SCROLL_QUIET_MS),
    );
  };
  const onPointerMove = (event: Event) => {
    const { movementX, movementY } = event as MouseEvent;
    if (quiet.size === 0 || (!movementX && !movementY)) return;
    restAll();
  };
  const onPointerDown = () => {
    pressed = true;
    restAll();
  };
  const onPointerUp = () => {
    pressed = false;
  };
  const pointer = { capture: true, passive: true } as const;

  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  doc.addEventListener("pointermove", onPointerMove, pointer);
  doc.addEventListener("pointerdown", onPointerDown, pointer);
  doc.addEventListener("pointerup", onPointerUp, pointer);
  doc.addEventListener("pointercancel", onPointerUp, pointer);
  return () => {
    doc.removeEventListener("scroll", onScroll, { capture: true });
    doc.removeEventListener("pointermove", onPointerMove, { capture: true });
    doc.removeEventListener("pointerdown", onPointerDown, { capture: true });
    doc.removeEventListener("pointerup", onPointerUp, { capture: true });
    doc.removeEventListener("pointercancel", onPointerUp, { capture: true });
    for (const [el, timer] of timers) {
      clearTimeout(timer);
      el.removeAttribute(SCROLLING_ATTR);
    }
    timers.clear();
    restAll();
  };
}
