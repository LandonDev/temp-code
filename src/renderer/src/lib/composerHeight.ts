/**
 * Fit a textarea's height to its content. A keystroke, and the clear after
 * a send, snap: nothing animates on a keystroke, and a height that eased on
 * every wrap dragged the transcript above it along. `animate` is the caller
 * saying the change came from no keystroke (a paste, a restore, a quote);
 * such a change of more than one line eases over `--dur-base`.
 * FLIP: measure the target at `auto`, put the old height back, force a
 * layout, then let the transition carry it. The box is bottom-anchored so
 * it grows upward. Reduced motion, a first fit or no change snaps.
 */
export function morphTextareaHeight(el: HTMLElement, max: number, animate = false): void {
  const prev = el.style.height;
  el.style.transition = "none";
  el.style.height = "auto";
  const target = Math.min(el.scrollHeight, max);
  const next = `${target}px`;
  const from = parseFloat(prev);
  if (
    !animate ||
    prev === next ||
    !Number.isFinite(from) ||
    Math.abs(target - from) <= lineHeight(el) ||
    prefersReducedMotion()
  ) {
    el.style.height = next;
    el.style.transition = "";
    return;
  }
  el.style.height = prev;
  void el.offsetHeight;
  el.style.transition = "height var(--dur-base) var(--ease-out)";
  el.style.height = next;
  const clear = (event: TransitionEvent): void => {
    if (event.propertyName !== "height") return;
    el.style.transition = "";
    el.removeEventListener("transitionend", clear);
  };
  el.addEventListener("transitionend", clear);
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
