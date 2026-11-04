import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";
import { SPINNER_TURN } from "@renderer/lib/ease";

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Turns the box around the arc as a Web Animation. Chromium leaves that to
 *  the compositor; a turn on the svg itself, CSS or Web Animation, made Blink
 *  run a main-thread frame at every display frame on macOS while any spinner
 *  showed: on a busy board, 35 of them took 37% of a core at 144 Hz, against
 *  13% for this form and 4.5% held still. */
function turn(box: HTMLSpanElement | null): (() => void) | undefined {
  if (!box || typeof box.animate !== "function" || reducedMotion()) return undefined;
  const animation = box.animate(SPINNER_TURN.keyframes, SPINNER_TURN.timing);
  return () => animation.cancel();
}

/** The one indeterminate spinner: a 16px arc on a 900ms turn, in the
 *  current colour. Pair it with a word; never spin alone in empty space.
 *  The class sizes the box; the arc fills it. A line that must not move
 *  draws working as a dot instead (StatusMark `still`). */
function Spinner({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      ref={turn}
      data-slot="spinner"
      data-turning=""
      role="status"
      aria-label="Loading"
      className={cn("inline-grid size-4 shrink-0 place-items-center", className)}
      {...props}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="size-full">
        <circle cx="12" cy="12" r="9" pathLength={100} strokeDasharray="72 100" className="origin-center -rotate-[135deg]" />
      </svg>
    </span>
  );
}

export { Spinner };
