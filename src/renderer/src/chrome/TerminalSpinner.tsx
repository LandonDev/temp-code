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

export function TerminalSpinner({
  className = "inline-block w-3.5 select-none text-center text-[11px] leading-none",
}: {
  className?: string;
}) {
  const [frame, setFrame] = useState(0);
  const shown = usePaneVisible();

  useEffect(() => {
    if (!shown) return;
    const id = window.setInterval(
      () => setFrame((n) => (n + 1) % FRAMES.length),
      80,
    );
    return () => window.clearInterval(id);
  }, [shown]);

  return (
    <span aria-hidden className={className}>
      {FRAMES[frame]}
    </span>
  );
}
