import { DUR } from "./ease";

/**
 * The composer's field sizes itself. At rest its inline height is unset:
 * the browser fits the box to its content under its max-height in its own
 * frame, so a keystroke writes no height and reads no layout (the field
 * once set `auto`, read `scrollHeight` and pinned the height in pixels on
 * every keystroke, a forced layout each time). A keystroke, and the clear
 * after a send, snap.
 *
 * A change that came from no keystroke (a paste, a restore, a quote) eases
 * when it moves the box by more than a line: `easeFieldHeight` reads the
 * rendered height once before the change, makes it, reads the new one,
 * pins the old height, forces a layout and lets the transition carry it
 * over `--dur-base` `--ease-out` (FLIP; the box is bottom-anchored, so it
 * grows upward), then clears the inline height again once the transition
 * ends. A second change mid-ease starts from where the box is drawn.
 * Reduced motion, a change of a line or less, or a box with no layout yet
 * snaps, pinning nothing.
 */

/** The field's running ease: ends it, leaving the height to the browser. */
const easing = new WeakMap<HTMLElement, () => void>();

/** A keystroke: a running ease snaps to where the content puts the box. Nothing is read or written otherwise. */
export function settleFieldHeight(el: HTMLElement): void {
  easing.get(el)?.();
}

export function easeFieldHeight(el: HTMLElement, change: () => void): void {
  const from = el.getBoundingClientRect().height;
  settleFieldHeight(el);
  change();
  const to = el.getBoundingClientRect().height;
  if (!from || !to || Math.abs(to - from) <= lineHeight(el) || prefersReducedMotion()) return;
  el.style.transition = "none";
  el.style.height = `${from}px`;
  void el.offsetHeight;
  el.style.transition = "height var(--dur-base) var(--ease-out)";
  el.style.height = `${to}px`;
  const end = (): void => {
    el.removeEventListener("transitionend", onEnd);
    clearTimeout(timer);
    easing.delete(el);
    el.style.transition = "";
    el.style.height = "";
  };
  const onEnd = (event: TransitionEvent): void => {
    if (event.target === el && event.propertyName === "height") end();
  };
  el.addEventListener("transitionend", onEnd);
  // A transition that never ends (the pane hidden mid-ease) still lets go.
  const timer = setTimeout(end, DUR.base * 1000 + 100);
  easing.set(el, end);
}

/** The field's line, read from its style; the composer's 22px when unset. */
function lineHeight(el: HTMLElement): number {
  const line = parseFloat(getComputedStyle(el).lineHeight);
  return Number.isFinite(line) ? line : 22;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
