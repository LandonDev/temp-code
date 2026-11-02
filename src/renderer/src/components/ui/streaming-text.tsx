import { useState } from "react";

/** A short live line arriving a phrase at a time, faded the way the
 *  transcript's prose is (lib/streamReveal.ts): each update's new text is one
 *  `.stream-step` span fading in over `--dur-reveal`. A growing line keeps
 *  its earlier spans, so their fades never replay; a line that is not the
 *  last one grown starts over as one span. Key the component to fade a
 *  replacement line in whole. For short live lines (the thinking row's
 *  newest sentence). */
export function StreamingText({ children, className }: { children: string; className?: string }) {
  const [parts, setParts] = useState<string[]>(() => (children ? [children] : []));
  const [prev, setPrev] = useState(children);
  if (children !== prev) {
    setPrev(children);
    setParts(children.startsWith(prev) && prev !== "" ? [...parts, children.slice(prev.length)] : children ? [children] : []);
  }
  return (
    <span className={className}>
      {parts.map((part, index) => (
        <span key={index} className="stream-step">
          {part}
        </span>
      ))}
    </span>
  );
}
