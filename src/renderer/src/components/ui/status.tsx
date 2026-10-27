import type { ComponentProps, ReactNode } from "react";
import type { SessionStatus } from "@shared/events";
import { Check, Circle, CircleAlert, CircleDashed, CircleDot, FileText, Pause, Square } from "@renderer/chrome/icons";
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
export type ThreadState = "working" | "waiting" | "paused" | "failed" | "queued" | "stopped" | "watching" | "plan-ready" | "done" | "idle";

export const STATUS_WORD: Record<ThreadState, string> = {
  working: "Working",
  waiting: "Needs you",
  paused: "Paused",
  failed: "Failed",
  queued: "Queued",
  stopped: "Stopped",
  watching: "Watching",
  "plan-ready": "Plan ready",
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
  "plan-ready": "muted",
  done: "muted",
  idle: "muted",
};

const TONE_CLASS: Record<StatusTone, string> = {
  foreground: "text-foreground",
  muted: "text-muted-foreground",
  attention: "text-warning",
  danger: "text-destructive",
};

/** The text colour the vocabulary gives a state, for a word set beside a mark (a count, a line). */
export function statusToneClass(state: ThreadState): string {
  return TONE_CLASS[STATUS_TONE[state]];
}

/**
 * A session's wire status as the vocabulary's state. `starting` and
 * `running` work; `error` failed; a plan written and not yet built
 * (`planReady`) is plan-ready whatever the status short of a live one;
 * `idle` after a completed turn is done (`settled`), else idle; an
 * undefined status (a row not yet listed) is idle. Every row that shows a
 * thread's state reads this, never a map of its own. A tally (3/7) is the
 * mark's detail text beside it; unread is weight on the title, never a dot.
 */
export function threadStateOf(
  status: SessionStatus | null | undefined,
  opts: { settled?: boolean; planReady?: boolean } = {},
): ThreadState {
  if (opts.planReady && status !== "starting" && status !== "running" && status !== "waiting" && status !== "error") return "plan-ready";
  switch (status) {
    case "starting":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "paused":
      return "paused";
    case "error":
      return "failed";
    case "queued":
      return "queued";
    case "stopped":
      return "stopped";
    case "watching":
      return "watching";
    case "done":
      return "done";
    case "idle":
      return opts.settled ? "done" : "idle";
    default:
      return "idle";
  }
}

/** What a host's link says: the transport's word, in one place. */
export type LinkTransport = "connecting" | "open" | "reconnecting" | "offline" | "unauthorized";

/**
 * A host link as a mark: Connected (a check, muted), Connecting and
 * Reconnecting (the spinner), Offline (stopped, muted), Unreachable since a
 * time (amber: the person has to look), Sign in needed (red). The host
 * rows, the environment switcher, the connection indicator and the thread
 * header's host chip all read this; none keeps a map of its own.
 */
export function linkMarkOf(
  transport: LinkTransport,
  opts: { unreachableSince?: number | null; now?: number } = {},
): { state: ThreadState; word: string } {
  switch (transport) {
    case "open":
      return { state: "done", word: "Connected" };
    case "connecting":
      return { state: "working", word: "Connecting" };
    case "reconnecting":
      return { state: "working", word: "Reconnecting" };
    case "unauthorized":
      return { state: "failed", word: "Sign in needed" };
    case "offline":
      return opts.unreachableSince
        ? { state: "waiting", word: `Unreachable since ${clockTime(opts.unreachableSince)}` }
        : { state: "stopped", word: "Offline" };
  }
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
      return <Circle className={c} />;
    case "plan-ready":
      return <FileText className={c} />;
    case "done":
      return <Check className={c} />;
    case "idle":
      return <Circle className={cn(c, "opacity-50")} />;
  }
}

/** A live state's glyph breathes once over `--dur-slow` when the state changes (the key remounts it); nothing loops. */
const LIVE: ReadonlySet<ThreadState> = new Set(["working", "waiting", "watching"]);

/** The glyph alone (`word={false}`) for tight rows, glyph and the state's word, or glyph and a given word (a link's). */
export function StatusMark({
  state,
  word = true,
  detail,
  className,
  ...props
}: ComponentProps<"span"> & {
  state: ThreadState;
  word?: boolean | string;
  /** What the state is about, muted after the word: "Working  typecheck", "Needs you  approve Bash", a tally "3/7". */
  detail?: ReactNode;
}) {
  const text = word === true ? STATUS_WORD[state] : word === false ? null : word;
  return (
    <span
      data-slot="status-mark"
      data-state={state}
      aria-label={text === null ? STATUS_WORD[state] : undefined}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium", TONE_CLASS[STATUS_TONE[state]], className)}
      {...props}
    >
      <span key={state} className={cn("flex", LIVE.has(state) && "status-breathe")}>
        <Glyph state={state} />
      </span>
      {text !== null ? (
        <span data-slot="status-word" className={detail != null && detail !== "" ? "shrink-0" : "min-w-0 truncate"}>
          {text}
        </span>
      ) : null}
      {detail != null && detail !== "" ? (
        <span data-slot="status-detail" className="min-w-0 truncate font-normal text-muted-foreground tabular-nums">
          {detail}
        </span>
      ) : null}
    </span>
  );
}
