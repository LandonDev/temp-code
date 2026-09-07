import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * A measured height fold (ported from temp-code). CSS cannot tween to
 * `auto`, so the body tweens between its measured start and its scroll
 * height, then hands back to `auto`/`0` on transitionend — with a timer
 * fallback for the frames where the event never fires (the tab was hidden,
 * the element unmounted mid-tween).
 */

export const TWEEN_MS = 200;
/** The tween plus a frame or two: fires only when transitionend never came. */
export const TWEEN_FALLBACK_MS = 260;

export interface TweenTarget {
  readonly scrollHeight: number;
  readonly offsetHeight: number;
  style: { transition: string; height: string };
  addEventListener(type: "transitionend", cb: () => void): void;
  removeEventListener(type: "transitionend", cb: () => void): void;
}

/**
 * Tween `el` to its open or closed height. Returns a cancel function that
 * detaches the listener and timer. Pure over the element and timers, so the
 * timing is unit-testable without a DOM.
 */
export function tweenHeight(
  el: TweenTarget,
  open: boolean,
  timers: { setTimeout: (cb: () => void, ms: number) => number; clearTimeout: (id: number) => void } = {
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  },
): () => void {
  const target = open ? el.scrollHeight : 0;
  const from = el.offsetHeight;
  let fallback = 0;
  const done = () => {
    el.style.transition = "none";
    el.style.height = open ? "auto" : "0px";
    el.removeEventListener("transitionend", done);
    timers.clearTimeout(fallback);
  };
  if (from === target) {
    done();
    return () => {};
  }
  el.style.transition = "none";
  el.style.height = `${from}px`;
  // Force layout so the browser sees the start height before the tween.
  void el.offsetHeight;
  el.style.transition = `height ${TWEEN_MS}ms ease-out`;
  el.style.height = `${target}px`;
  el.addEventListener("transitionend", done);
  fallback = timers.setTimeout(done, TWEEN_FALLBACK_MS);
  return () => {
    el.removeEventListener("transitionend", done);
    timers.clearTimeout(fallback);
  };
}

export function TweenHeight({
  open,
  animate,
  children,
  className,
}: {
  open: boolean;
  /** False (reduced motion, first paint) snaps instead of tweening. */
  animate: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current || !animate) {
      first.current = false;
      el.style.transition = "none";
      el.style.height = open ? "auto" : "0px";
      return;
    }
    return tweenHeight(el, open);
  }, [open, animate]);
  return (
    <div
      ref={ref}
      className={className ? `overflow-hidden ${className}` : "overflow-hidden"}
      style={{ height: open ? "auto" : 0 }}
    >
      {children}
    </div>
  );
}
