import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";
import { SPINNER_TURN } from "@renderer/lib/ease";

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Turns the arc as a Web Animation, which runs on the compositor alone. As
 *  a CSS animation the turn made Blink run a main-thread frame at every
 *  display frame while any spinner showed: on a busy board, 35 of them took
 *  36% of a core at 144 Hz on the Mac, against 4.5% held still. */
function turn(svg: SVGSVGElement | null): (() => void) | undefined {
  if (!svg || typeof svg.animate !== "function" || reducedMotion()) return undefined;
  const animation = svg.animate(SPINNER_TURN.keyframes, SPINNER_TURN.timing);
  return () => animation.cancel();
}

/** The one indeterminate spinner: a 16px arc on a 900ms turn, in the
 *  current colour. Pair it with a word; never spin alone in empty space.
 *  `still` draws the arc without its turn. */
function Spinner({ className, still, ...props }: ComponentProps<"svg"> & { still?: boolean }) {
  return (
    <svg
      ref={still ? undefined : turn}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      data-slot="spinner"
      data-turning={still ? undefined : ""}
      role="status"
      aria-label="Loading"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" pathLength={100} strokeDasharray="72 100" className="origin-center -rotate-[135deg]" />
    </svg>
  );
}

export { Spinner };
