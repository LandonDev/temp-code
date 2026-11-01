import { useMemo } from "react";

const WHITESPACE = /(\s+)/;

/** A short live line arriving a word at a time: each new word fades in over
 *  `--dur-base` (`.streaming-word` in components.css). Words are keyed by
 *  position, so appended words fade and settled ones never replay; key the
 *  component to fade a replacement line in whole. For short live lines (the
 *  thinking row's newest sentence); the transcript's prose keeps its jitter
 *  buffer and veil. Never inside `TextShimmer`: its gradient paints through
 *  every descendant's glyphs, so a word's fade cannot show. */
export function StreamingText({ children, className }: { children: string; className?: string }) {
  const parts = useMemo(() => children.split(WHITESPACE), [children]);
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part === "" || WHITESPACE.test(part) ? (
          part
        ) : (
          <span key={index} className="streaming-word">
            {part}
          </span>
        ),
      )}
    </span>
  );
}
