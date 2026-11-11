import { useReducedMotion } from "motion/react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { OVERFLOW_FADE_Y, useOverflowEdges } from "@renderer/hooks/useOverflowEdges";
import { cn } from "@renderer/lib/cn";
import { useHeightGlide } from "@renderer/lib/heightGlide";
import { useClock } from "@renderer/lib/turnClock";
import { spanWords, thoughtLines } from "@renderer/surfaces/transcript/thinking";

/**
 * Kobra's Reasoning Steps, adapted flat: the model's thought arriving under
 * the working line as it streams (surfaces/transcript/WorkingLine.tsx). The
 * head row is the working line itself (`WorkingMark`, then "Thinking" in
 * `WorkingText`'s shimmer and `ThoughtSeconds`); this is the column under it.
 *
 * Driven by the thought's text, never by a timer: `thoughtLines` gives the
 * finished sentences by paragraph (an unfinished one waits), each sentence a
 * span keyed by its place that fades in once on `.stream-step` (the stream's
 * own phrase fade, opacity alone, none under reduced motion) and then stays
 * put; a paragraph is a `p`, 8px from the next. 14px on 22px lines, muted:
 * the prose's type, at the thought's weight. The column grows to its newest
 * line on `useHeightGlide` (`--dur-base`), is capped at 192px and then
 * scrolls, following its newest line unless the person scrolled it up (a
 * wheel or a key toward the top holds it there until they reach the bottom
 * again), and fades 32px at a top or bottom edge that has more past it
 * (`OVERFLOW_FADE_Y`). A column that scrolls takes focus and the one ring,
 * so the keyboard can read it. No live region: the line's own status says
 * Thinking once, and no sentence is read out. The caller opens and closes it
 * on a fold of its own (`.collapsible-auto` under the working line).
 */
export const ReasoningColumn = memo(function ReasoningColumn({ text, live, className }: { text: string; live: boolean; className?: string }) {
  const reduce = useReducedMotion() === true;
  const paragraphs = useMemo(() => thoughtLines(text), [text]);
  // The finished text, one string: what the column has to draw changes only when it does.
  const shown = useMemo(() => paragraphs.map((p) => p.join(" ")).join("\n"), [paragraphs]);
  const count = paragraphs.reduce((n, p) => n + p.length, 0);
  const box = useRef<HTMLDivElement>(null);
  const edges = useOverflowEdges<HTMLDivElement>("y");
  // Where the person left it: at the newest line until they move away from it.
  const held = useRef(false);
  // The count the column last followed; null before its first, when it jumps.
  const followed = useRef<number | null>(null);
  useHeightGlide(box, count, { enabled: live, curve: "base" });

  // A new sentence: follow it, unless the person scrolled up to read. A column
  // that mounts tall (a thread opened mid-thought) jumps to its newest line.
  useLayoutEffect(() => {
    const el = box.current;
    const first = followed.current === null;
    followed.current = count;
    if (!el || held.current || count === 0) return;
    const top = el.scrollHeight - el.clientHeight;
    if (top <= el.scrollTop) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top, behavior: reduce || first ? "auto" : "smooth" });
    else el.scrollTop = top;
  }, [count, reduce]);

  const attach = (el: HTMLDivElement | null) => {
    box.current = el;
    edges(el);
  };
  const onScroll = () => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight <= 1) held.current = false;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) held.current = true;
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") held.current = true;
  };
  const scrolls = count > 0;

  return (
    <div
      ref={attach}
      data-slot="reasoning-column"
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-label={scrolls ? "Reasoning" : undefined}
      onScroll={onScroll}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      className={cn(
        "focus-ring scrollbar-none max-h-48 min-w-0 space-y-2 overflow-x-hidden overflow-y-auto rounded-md text-sm leading-[22px] text-muted-foreground",
        OVERFLOW_FADE_Y,
        className,
      )}
    >
      <Paragraphs paragraphs={paragraphs} shown={shown} />
    </div>
  );
});

/**
 * The sentences, rendered only when one finishes: `shown` is the finished
 * text, so the twenty deltas a second that end no sentence re-render nothing
 * here (the memo compares the string, never the fresh arrays), and a sentence
 * once drawn is never diffed again.
 */
const Paragraphs = memo(
  function Paragraphs({ paragraphs }: { paragraphs: string[][]; shown: string }) {
    return paragraphs.map((sentences, p) => (
      <p key={p} dir="auto">
        {sentences.map((sentence, i) => (
          <span key={i} className="stream-step">
            {i > 0 ? " " : null}
            {sentence}
          </span>
        ))}
      </p>
    ));
  },
  (a, b) => a.shown === b.shown,
);

/**
 * The seconds a thought block has run, 4px after "Thinking" on the working
 * line: "4s", past a minute "1m 12s" (`spanWords`), counted from the block's
 * own `startedAt` on the shared second hand (lib/turnClock.ts), so only this
 * span re-renders on the tick and nothing adds a timer. Tabular, muted, and
 * outside the shimmer's words so a tick re-runs nothing. Nothing without a
 * start to count from.
 */
export function ThoughtSeconds({ startedAt, live }: { startedAt: number | undefined; live: boolean }) {
  const now = useClock(live && startedAt !== undefined);
  if (startedAt === undefined || now === 0) return null;
  return (
    <span data-slot="thought-seconds" className="shrink-0 tabular-nums text-muted-foreground">
      {spanWords(now - startedAt)}
    </span>
  );
}
