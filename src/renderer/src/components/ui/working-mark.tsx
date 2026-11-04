import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useDocumentVisible, usePaneVisible } from "@renderer/hooks/paneVisibility";
import { cn } from "@renderer/lib/cn";
import { MARK } from "@renderer/lib/ease";
import { statusToneClass } from "./status";

/**
 * The working line's mark (surfaces/transcript/WorkingLine.tsx): three 3px
 * dots in the working tone that gather into one and part again. Each dot is
 * its own span moved by one Web Animation of `transform` alone (MARK in
 * lib/ease.ts), so the compositor runs it; every animation starts at 0 on the
 * document timeline, so a mark that remounts picks the gesture up where every
 * other mark is instead of restarting it. Still (the three dots at rest)
 * under reduced motion, in a hidden pane and while the document is hidden.
 * The spinner stays the working glyph everywhere else.
 */
export function WorkingMark({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const pane = usePaneVisible();
  const page = useDocumentVisible();
  const moving = !reduce && pane && page;
  const dots = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!moving) return undefined;
    const running = dots.current.flatMap((dot, i) => {
      if (!dot || typeof dot.animate !== "function") return [];
      const animation = dot.animate(MARK.dots[i], MARK.timing);
      animation.startTime = 0;
      return [animation];
    });
    return () => {
      for (const animation of running) animation.cancel();
    };
  }, [moving]);

  return (
    <span
      aria-hidden
      data-slot="working-mark"
      data-moving={moving ? "" : undefined}
      className={cn("inline-grid size-3.5 shrink-0 place-items-center", statusToneClass("working"), className)}
    >
      {MARK.dots.map((frames, i) => (
        <span
          key={i}
          ref={(node) => {
            dots.current[i] = node;
          }}
          className="col-start-1 row-start-1 size-[3px] rounded-full bg-current"
          style={{ transform: frames[0].transform as string }}
        />
      ))}
    </span>
  );
}
