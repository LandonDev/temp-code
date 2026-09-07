/**
 * Grow or shrink a textarea to fit its content with a short height tween.
 * FLIP: measure the target at `auto`, put the old height back, force a
 * layout, then let the transition carry it. The box is bottom-anchored so
 * it grows upward. Reduced motion, or no change, snaps.
 */
export function morphTextareaHeight(el: HTMLElement, max: number): void {
  const prev = el.style.height;
  el.style.transition = "none";
  el.style.height = "auto";
  const target = Math.min(el.scrollHeight, max);
  const next = `${target}px`;
  if (prev === next || prev === "" || prefersReducedMotion()) {
    el.style.height = next;
    el.style.transition = "";
    return;
  }
  el.style.height = prev;
  void el.offsetHeight;
  el.style.transition = "height 180ms ease-out";
  el.style.height = next;
  const clear = (event: TransitionEvent): void => {
    if (event.propertyName !== "height") return;
    el.style.transition = "";
    el.removeEventListener("transitionend", clear);
  };
  el.addEventListener("transitionend", clear);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
