import { useMemo } from "react";

const WHITESPACE = /(\s+)/;

/** A reply arriving a word at a time: each new word fades in over 180ms
 *  (`.streaming-word` in components.css). For short live lines (a status,
 *  a title being written); the transcript's prose keeps its jitter buffer
 *  (lib/smoothText) and its markdown pipeline. */
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
