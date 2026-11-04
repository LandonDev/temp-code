import { useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { useDocumentVisible, usePaneVisible } from "@renderer/hooks/paneVisibility";
import { cn } from "@renderer/lib/cn";
import { SHIMMER } from "@renderer/lib/ease";

const canAnimate = () => typeof document !== "undefined" && typeof document.documentElement.animate === "function";

/**
 * The one "words being produced" text (the working line, a compaction, a
 * handoff being prepared): the words drawn muted, and over them a bright
 * band that crosses every 3s. The band is a static mask (a token colour, so
 * nothing repaints) holding a foreground copy of the words; the band moves
 * one way and the copy the other, so the copy stays exactly over the words
 * while the bright window crosses them. The copy is the band's `::before`,
 * drawn from `data-words`, so the words are in the document once (find in
 * page, a selection and `textContent` see them once). Both are Web Animations of
 * `transform` alone (SHIMMER in lib/ease.ts), started at 0 on the document
 * timeline so new words continue the sweep where the old left off. The
 * overlay is not mounted under reduced motion, in a hidden pane or while the
 * document is hidden: the words are then still muted text.
 */
export function WorkingText({ children, words, className }: { children: ReactNode; words?: string; className?: string }) {
  const reduce = useReducedMotion();
  const pane = usePaneVisible();
  const page = useDocumentVisible();
  const text = words ?? (typeof children === "string" ? children : undefined);
  const moving = !reduce && pane && page && Boolean(text) && canAnimate();
  const band = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const b = band.current;
    if (!moving || !b) return undefined;
    const running = [b.animate(SHIMMER.band, SHIMMER.timing), b.animate(SHIMMER.copy, { ...SHIMMER.timing, pseudoElement: "::before" })];
    for (const animation of running) animation.startTime = 0;
    return () => {
      for (const animation of running) animation.cancel();
    };
  }, [moving]);

  return (
    <span data-slot="working-text" className={cn("relative inline-block min-w-0 truncate text-muted-foreground", className)}>
      {children}
      {moving && (
        <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <span
            ref={band}
            data-shimmer="band"
            data-words={text}
            className="absolute inset-0 select-none [mask-image:linear-gradient(90deg,transparent,var(--foreground)_40%,var(--foreground)_60%,transparent)] before:absolute before:inset-0 before:truncate before:text-foreground before:content-[attr(data-words)]"
          />
        </span>
      )}
    </span>
  );
}
