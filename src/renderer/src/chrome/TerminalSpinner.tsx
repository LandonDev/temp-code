import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { usePaneVisible } from "../hooks/paneVisibility";

const FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** A braille spinner one glyph wide; `className` only tints it. It holds a
 *  frame in a parked pane and under reduced motion. */
export function TerminalSpinner({ className = "" }: { className?: string }) {
  const [frame, setFrame] = useState(0);
  const shown = usePaneVisible();
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!shown || reduce) return;
    const id = window.setInterval(
      () => setFrame((n) => (n + 1) % FRAMES.length),
      80,
    );
    return () => window.clearInterval(id);
  }, [shown, reduce]);

  return (
    <span
      aria-hidden
      className={`inline-block w-3.5 shrink-0 select-none text-center text-[11px] leading-none ${className}`}
    >
      {FRAMES[frame]}
    </span>
  );
}
