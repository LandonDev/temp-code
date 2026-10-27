// A9 (closing lines): a turn's closing row.
import type { HandoffHandler, SecondOpinionHandler } from "./types";
import { Check, Copy, FilePlusCorner } from "../../chrome/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { HandoffButton, SecondOpinionButton } from "../../chrome/SecondOpinionButton";
import { STATUS_WORD, StatusMark } from "../../components/ui/status";
import { cn } from "../../lib/cn";
import { copyText } from "../../lib/clipboard";
import { playCue } from "../../lib/sounds";
import { type TurnInfo } from "../transcriptRows";
import { type Block, type HarnessId } from "../../lib/session";
import { isTurnPaused, turnElapsed, useClock } from "../../lib/turnClock";
import { useTurnState, type TurnSession } from "../turnState";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { storeTitleOf, threadMentionsToTitles } from "../../lib/threadMentions";
import { needsApproval, turnCopyText } from "../transcriptActivity";
import { IconAction, SwapIcon, useArmOnIntent } from "./IconAction";
import { spanWords } from "./thinking";
import { ThinkingTail } from "./ThinkingRow";

/** A turn's closing row: the thinking tail while it starts, its duration
 *  line once it is over, the live state while it runs or waits. */
export function TurnEnd({
  turn,
  harnessOf,
  turnState,
  onSaveNote,
  onSecondOpinion,
  onHandoff,
}: {
  turn: TurnInfo;
  harnessOf: (turn: Block[]) => HarnessId | undefined;
  turnState: TurnSession | null;
  onSaveNote?: (text: string) => void;
  onSecondOpinion?: SecondOpinionHandler;
  onHandoff?: HandoffHandler;
}) {
  const { settled, durationMs, isLast } = turn;
  // Settled only: the live turn's harness is not known until it answers.
  const fromHarness = useMemo(
    () => (settled ? harnessOf(turn.blocks) : undefined),
    [settled, harnessOf, turn.blocks],
  );
  return (
    <>
      {!settled && showsThinkingTail(turn.blocks) ? (
        <ThinkingTail />
      ) : null}
      {durationMs != null && settled ? (
        <TurnDuration
          elapsedMs={durationMs}
          done
          copyText={threadMentionsToTitles(turnCopyText(turn.blocks), storeTitleOf)}
          onSaveNote={onSaveNote}
          fromHarness={fromHarness}
          onSecondOpinion={
            onSecondOpinion
              ? (target, model) => onSecondOpinion(target, turn.blocks, model)
              : undefined
          }
          onHandoff={
            onHandoff ? (target, model) => onHandoff(target, turn.blocks, model) : undefined
          }
        />
      ) : null}
      {isLast && (!settled || (durationMs == null && turnState && isTurnPaused(turnState))) ? (
        <LiveTurnDuration turn={turn.blocks} />
      ) : null}
    </>
  );
}

/**
 * The live state of the turn still in flight. Ticks on the shared clock
 * so only this row re-renders each second, never the transcript.
 */
export function LiveTurnDuration({ turn }: { turn: Block[] }) {
  const session = useTurnState();
  const paused = session ? isTurnPaused(session) : false;
  const now = useClock(!paused && usePaneVisible());
  const elapsed = session ? turnElapsed(session, now) : null;
  const waiting = turn.some(
    (b) => needsApproval(b) || (b.question != null && b.question.answers === undefined),
  );
  return (
    <TurnDuration elapsedMs={elapsed} live waiting={waiting} paused={paused} />
  );
}

const LINE = "flex h-7 mt-1 mb-3 items-center gap-2 font-sans text-[13px] tabular-nums text-muted-foreground";

/**
 * A turn's closing line. Settled: "Worked for 2m 4s", then copy, save as
 * note, hand off and second opinion, shown on the line's hover or focus.
 * Live: the state in StatusMark's words, with the time where it means
 * something.
 */
export function TurnDuration({
  elapsedMs,
  live = false,
  done = false,
  waiting = false,
  paused = false,
  copyText: output,
  onSaveNote,
  fromHarness,
  onSecondOpinion,
  onHandoff,
}: {
  elapsedMs: number | null;
  live?: boolean;
  done?: boolean;
  waiting?: boolean;
  /** Frozen mid-turn: the elapsed time holds. */
  paused?: boolean;
  copyText?: string;
  onSaveNote?: (text: string) => void;
  fromHarness?: HarnessId;
  onSecondOpinion?: (harness: HarnessId, model: string) => void;
  onHandoff?: (harness: HarnessId, model: string) => void;
}) {
  const [armed, intent] = useArmOnIntent();
  if (done) {
    return (
      <div className={cn(LINE, "group/turnend")} {...intent}>
        <span>{formatWorkingDuration(elapsedMs, true)}</span>
        <span className="flex items-center opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) focus-within:opacity-100 group-hover/turnend:opacity-100 motion-reduce:transition-none">
          {output ? <CopyTurnButton text={output} armed={armed} /> : null}
          {output && onSaveNote ? <SaveNoteButton text={output} onSave={onSaveNote} armed={armed} /> : null}
          {fromHarness && onHandoff ? <HandoffButton from={fromHarness} onPick={onHandoff} armed={armed} /> : null}
          {fromHarness && onSecondOpinion ? (
            <SecondOpinionButton from={fromHarness} onPick={onSecondOpinion} armed={armed} />
          ) : null}
        </span>
      </div>
    );
  }
  const state = paused ? "paused" : waiting ? "waiting" : "working";
  return (
    <div role={live ? "status" : undefined} aria-label={STATUS_WORD[state]} className={LINE}>
      <StatusMark state={state} />
      {state === "working" && elapsedMs != null ? <span aria-hidden>{spanWords(elapsedMs)}</span> : null}
      {state === "paused" && elapsedMs != null ? <span aria-hidden>worked {spanWords(elapsedMs)}</span> : null}
    </div>
  );
}

export function CopyTurnButton({ text, armed }: { text: string; armed?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCopied(false);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [text]);

  return (
    <IconAction
      label={copied ? "Copied" : "Copy response"}
      armed={armed}
      onClick={() => {
        playCue("copy");
        void copyText(text).then(
          () => {
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      <SwapIcon swapped={copied} from={<Copy className="size-3.5" />} to={<Check className="size-3.5" />} />
    </IconAction>
  );
}

export function SaveNoteButton({
  text,
  onSave,
  armed,
}: {
  text: string;
  onSave: (text: string) => void;
  armed?: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setSaved(false);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [text]);

  return (
    <IconAction
      label={saved ? "Saved to Notes" : "Save as note"}
      armed={armed}
      onClick={() => {
        playCue("copy");
        onSave(text);
        setSaved(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setSaved(false), 2000);
      }}
    >
      <SwapIcon swapped={saved} from={<FilePlusCorner className="size-3.5" />} to={<Check className="size-3.5" />} />
    </IconAction>
  );
}

/** "Worked for 2m 4s" once done, "Working for 12s" while it runs. */
export function formatWorkingDuration(elapsedMs: number | null, done = false): string {
  if (elapsedMs == null) return done ? "Worked" : "Working…";
  return `${done ? "Worked" : "Working"} for ${spanWords(elapsedMs)}`;
}

/**
 * A live turn with nothing to show yet ends in the thinking row's tail: after
 * the prompt, behind an empty reasoning block, or before the first word of
 * the answer. The next content takes that slot, so nothing jumps.
 */
export function showsThinkingTail(turn: Block[]): boolean {
  const last = turn[turn.length - 1];
  if (!last || last.role === "user") return true;
  if (last.role === "reasoning" || last.role === "assistant") return !last.text;
  return false;
}
