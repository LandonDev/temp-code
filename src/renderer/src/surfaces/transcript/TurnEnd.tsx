// A9 (closing lines): a turn's closing row.
import type { HandoffHandler, SecondOpinionHandler } from "./types";
import { Check, Copy, FilePlusCorner, Pause } from "../../chrome/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { HandoffButton, SecondOpinionButton } from "../../chrome/SecondOpinionButton";
import { TerminalSpinner } from "../../chrome/TerminalSpinner";
import { copyText } from "../../lib/clipboard";
import { playCue } from "../../lib/sounds";
import { Shimmer } from "../Shimmer";
import { type TurnInfo } from "../transcriptRows";
import { type Block, type HarnessId } from "../../lib/session";
import { isTurnPaused, turnElapsed, useClock } from "../../lib/turnClock";
import { useTurnState, type TurnSession } from "../turnState";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { storeTitleOf, threadMentionsToTitles } from "../../lib/threadMentions";
import { needsApproval, turnCopyText } from "../transcriptActivity";

/** A turn's closing row: the thinking tail while it starts, its duration
 *  line once it is over, the live timer while it runs or waits. */
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
  const { settled, durationMs, startedAt, isLast } = turn;
  // Settled only: the live turn's harness is not known until it answers.
  const fromHarness = useMemo(
    () => (settled ? harnessOf(turn.blocks) : undefined),
    [settled, harnessOf, turn.blocks],
  );
  return (
    <>
      {!settled && showsThinkingTail(turn.blocks) ? (
        <div className="z-fade-in flex h-[26px] items-center font-sans text-sm">
          <Shimmer>Thinking</Shimmer>
        </div>
      ) : null}
      {durationMs != null && settled ? (
        <TurnDuration
          elapsedMs={durationMs}
          done
          completedAt={startedAt != null ? startedAt + durationMs : undefined}
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
 * The running timer for the turn still in flight. Ticks on the shared clock
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

export function TurnDuration({
  elapsedMs,
  live = false,
  done = false,
  waiting = false,
  paused = false,
  completedAt,
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
  /** Frozen mid-turn: the elapsed time holds and the spinner stops. */
  paused?: boolean;
  completedAt?: number;
  copyText?: string;
  onSaveNote?: (text: string) => void;
  fromHarness?: HarnessId;
  onSecondOpinion?: (harness: HarnessId, model: string) => void;
  onHandoff?: (harness: HarnessId, model: string) => void;
}) {
  const label = paused
    ? `Paused · ${formatWorkingDuration(elapsedMs, true).replace(/^Worked/, "worked")}`
    : waiting
      ? "Waiting for you"
      : formatWorkingDuration(elapsedMs, done);
  const dot = (
    <span
      aria-hidden
      className="size-[3px] shrink-0 rounded-full bg-content/20"
    />
  );
  return (
    <div
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      aria-label={
        paused ? "Paused" : waiting ? "Waiting for you" : live ? "Agent is working" : label
      }
      className="flex items-center gap-3 pt-1 pb-3 font-sans text-sm tabular-nums text-content/40"
    >
      {done ? (
        <span className="flex items-center gap-2">
          {output ? (
            <>
              <CopyTurnButton text={output} />
              {onSaveNote ? (
                <SaveNoteButton text={output} onSave={onSaveNote} />
              ) : null}
            </>
          ) : (
            <Check className="size-3.5" strokeWidth={1.75} />
          )}
          {fromHarness && onHandoff ? (
            <HandoffButton from={fromHarness} onPick={onHandoff} />
          ) : null}
          {fromHarness && onSecondOpinion ? (
            <SecondOpinionButton from={fromHarness} onPick={onSecondOpinion} />
          ) : null}
        </span>
      ) : paused ? (
        <Pause className="size-3.5" strokeWidth={1.75} />
      ) : (
        <TerminalSpinner />
      )}

      {done ? dot : null}

      {live && !done && !paused ? (
        <Shimmer>{label}</Shimmer>
      ) : (
        <span>{label}</span>
      )}

      {completedAt != null ? (
        <>
          {dot}
          <span className="text-content/40">
            {formatClockTime(completedAt)}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** Wall-clock stamp for a finished turn, in the reader's own locale. */
export const clockTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
export function formatClockTime(epochMs: number): string {
  return clockTimeFormat.format(epochMs);
}

export function CopyTurnButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCopied(false);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [text]);

  return (
    <button
      type="button"
      title={copied ? "Copied" : "Copy response"}
      aria-label={copied ? "Copied" : "Copy response"}
      className="-ml-1 rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70"
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
      {copied ? (
        <Check className="size-3.5" strokeWidth={1.75} />
      ) : (
        <Copy className="size-3.5" strokeWidth={1.75} />
      )}
    </button>
  );
}

export function SaveNoteButton({
  text,
  onSave,
}: {
  text: string;
  onSave: (text: string) => void;
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
    <button
      type="button"
      title={saved ? "Saved to Notes" : "Save as note"}
      aria-label={saved ? "Saved to Notes" : "Save as note"}
      className="rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70"
      onClick={() => {
        playCue("copy");
        onSave(text);
        setSaved(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setSaved(false), 2000);
      }}
    >
      {saved ? (
        <Check className="size-3.5" strokeWidth={1.75} />
      ) : (
        <FilePlusCorner className="size-3.5" strokeWidth={1.75} />
      )}
    </button>
  );
}

export function formatWorkingDuration(elapsedMs: number | null, done = false): string {
  if (elapsedMs == null) return done ? "Worked" : "Working…";
  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
  const label = done ? "Worked for" : "Working for";
  if (totalSec < 60) return `${label} ${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${label} ${minutes}m ${seconds}s` : `${label} ${minutes}m`;
}

/**
 * A live turn with nothing to show yet ends in a "Thinking" shimmer: after
 * the prompt, behind an empty reasoning block, or before the first word of
 * the answer. The next content takes that slot, so nothing jumps.
 */
export function showsThinkingTail(turn: Block[]): boolean {
  const last = turn[turn.length - 1];
  if (!last || last.role === "user") return true;
  if (last.role === "reasoning" || last.role === "assistant") return !last.text;
  return false;
}
