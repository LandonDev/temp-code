import { type RefObject, useLayoutEffect, useRef } from "react";
import { DUR, SPRING_LAYOUT_CSS } from "./ease";

/**
 * A box whose content grows or shrinks glides to its new height instead of
 * stepping: the open tool table when rows land (transcript/ActionGroup.tsx),
 * a streaming code block when a line lands (surfaces/CodeBlock.tsx).
 *
 * `layout` is the layout spring the table's fold lives in; `base` is the
 * short ease a code block grows on. The box clips what lies past its drawn
 * height, so content is cut while it glides, never overlaid.
 */
export type GlideCurve = "layout" | "base";

const CURVES: Record<GlideCurve, { transition: string; ms: number }> = {
  layout: { transition: "height var(--dur-layout) var(--ease-layout)", ms: SPRING_LAYOUT_CSS.ms },
  base: { transition: "height var(--dur-base) var(--ease-out)", ms: DUR.base * 1000 },
};

/** Past the curve's time a glide ends on its own, transitionend or not. */
const END_SLACK_MS = 50;

type Glide = { end: () => void };

const glides = new WeakMap<HTMLElement, Glide>();

/** Whether a glide is under way on the box. */
export function isGliding(box: HTMLElement): boolean {
  return glides.has(box);
}

/** Ends the box's glide at once: its natural height shows. */
export function stopGlide(box: HTMLElement): void {
  glides.get(box)?.end();
}

/**
 * Glides `box` from `before` (the height it was drawn at before its content
 * changed) to its natural height now. Mid-glide the drawn height is the
 * animated one, so a change that lands while it glides retargets from where
 * the box is on screen. Nothing moves under reduced motion, for a box with no
 * layout (a hidden pane) or for a change under a pixel. Returns the natural
 * height.
 */
export function glideHeight(box: HTMLElement, curve: GlideCurve, before: number | null): number {
  const from = isGliding(box) || before === null ? box.getBoundingClientRect().height : before;
  stopGlide(box);
  const to = box.offsetHeight;
  if (Math.abs(to - from) < 1 || !box.isConnected || box.offsetParent === null || prefersReducedMotion()) return to;
  const { transition, ms } = CURVES[curve];
  box.style.transition = "none";
  box.style.height = `${from}px`;
  void box.offsetHeight;
  box.style.transition = transition;
  box.style.height = `${to}px`;
  box.dataset.heightGlide = "";
  const onEnd = (event: TransitionEvent): void => {
    // A row's own transitions bubble up to the box; only its height ends it.
    if (event.target === box && event.propertyName === "height") end();
  };
  const timer = setTimeout(() => end(), ms + END_SLACK_MS);
  const end = (): void => {
    clearTimeout(timer);
    box.removeEventListener("transitionend", onEnd);
    box.style.transition = "";
    box.style.height = "";
    delete box.dataset.heightGlide;
    glides.delete(box);
  };
  box.addEventListener("transitionend", onEnd);
  glides.set(box, { end });
  return to;
}

/**
 * Glides `boxRef`'s box whenever `key` changes, never on the first run, so
 * nothing moves at mount. The height it glides from is the one it was last
 * drawn at: the natural height after the previous change, kept fresh by a
 * ResizeObserver for growth the key does not name (a row's body opening).
 * `enabled` turning false ends a glide at once. `hold` names what else may
 * change the box in the same commit with motion of its own (a fold opening,
 * a table's entry): a commit that changes it glides nothing.
 */
export function useHeightGlide(
  boxRef: RefObject<HTMLElement | null>,
  key: string | number,
  { enabled, curve, hold = "" }: { enabled: boolean; curve: GlideCurve; hold?: string },
): void {
  const drawn = useRef<number | null>(null);
  const lastKey = useRef(key);
  const lastHold = useRef(hold);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    drawn.current = box.offsetHeight;
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (!isGliding(box)) drawn.current = box.offsetHeight;
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      stopGlide(box);
    };
  }, [boxRef]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const held = lastHold.current !== hold;
    lastHold.current = hold;
    if (!enabled || held) stopGlide(box);
    if (lastKey.current === key) return;
    lastKey.current = key;
    drawn.current = enabled && !held ? glideHeight(box, curve, drawn.current) : box.offsetHeight;
  }, [boxRef, key, enabled, curve, hold]);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
