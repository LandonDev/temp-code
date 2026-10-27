import type { ComponentProps } from "react";
import { Check, Circle, CircleAlert, CircleDashed, CircleDot, Pause, Square } from "@renderer/chrome/icons";
import { cn } from "@renderer/lib/cn";
import { Spinner } from "./spinner";

/**
 * The status vocabulary: one glyph, one word and one tone per state, for
 * every rail row, tab, strip, board row and card in the app. Nothing else
 * may map a status to a colour or a word.
 *
 * Colour carries meaning alone: amber means the person is needed, red
 * means failed; everything else is the foreground or muted.
 */
export type ThreadState = "working" | "waiting" | "paused" | "failed" | "queued" | "stopped" | "watching" | "done" | "idle";

export const STATUS_WORD: Record<ThreadState, string> = {
  working: "Working",
  waiting: "Needs you",
  paused: "Paused",
  failed: "Failed",
  queued: "Queued",
  stopped: "Stopped",
  watching: "Watching",
  done: "Done",
  idle: "Idle",
};

export type StatusTone = "foreground" | "muted" | "attention" | "danger";

export const STATUS_TONE: Record<ThreadState, StatusTone> = {
  working: "foreground",
  waiting: "attention",
  paused: "muted",
  failed: "danger",
  queued: "muted",
  stopped: "muted",
  watching: "muted",
  done: "muted",
  idle: "muted",
};

const TONE_CLASS: Record<StatusTone, string> = {
  foreground: "text-foreground",
  muted: "text-muted-foreground",
  attention: "text-warning",
  danger: "text-destructive",
};

/** Does the state need the person's eyes: a live dot in the rail, an unread-style weight. */
export function statusNeedsYou(state: ThreadState): boolean {
  return state === "waiting" || state === "failed";
}

function Glyph({ state, className }: { state: ThreadState; className?: string }) {
  const c = cn("size-3.5 shrink-0", className);
  switch (state) {
    case "working":
      return <Spinner className={cn(c, "size-3")} />;
    case "waiting":
      return <CircleDot className={c} />;
    case "paused":
      return <Pause className={c} />;
    case "failed":
      return <CircleAlert className={c} />;
    case "queued":
      return <CircleDashed className={c} />;
    case "stopped":
      return <Square className={cn(c, "size-3")} />;
    case "watching":
      return <Circle className={cn(c, "status-watching")} />;
    case "done":
      return <Check className={c} />;
    case "idle":
      return <Circle className={cn(c, "opacity-50")} />;
  }
}

/** The glyph alone (`word={false}`) for tight rows, or glyph and word. */
export function StatusMark({ state, word = true, className, ...props }: ComponentProps<"span"> & { state: ThreadState; word?: boolean }) {
  return (
    <span
      data-slot="status-mark"
      data-state={state}
      aria-label={word ? undefined : STATUS_WORD[state]}
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TONE_CLASS[STATUS_TONE[state]], className)}
      {...props}
    >
      <Glyph state={state} />
      {word ? STATUS_WORD[state] : null}
    </span>
  );
}
