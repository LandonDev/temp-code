// A9 (closing lines): a turn's closing row.
import type { HandoffHandler, SecondOpinionHandler } from "./types";
import { Check, Copy, FilePlusCorner } from "../../chrome/icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HandoffButton, SecondOpinionButton } from "../../chrome/SecondOpinionButton";
import { Collapsible, CollapsibleContent } from "../../components/ui/collapsible";
import { STATUS_WORD, StatusMark, statusToneClass } from "../../components/ui/status";
import { reveal } from "../../components/ui/reveal";
import { MorphText } from "../../motion/MorphText";
import { cn } from "../../lib/cn";
import { COPIED_MS, copyText } from "../../lib/clipboard";
import { playCue } from "../../lib/sounds";
import { type TurnInfo } from "../transcriptRows";
import { type Block, type HarnessId } from "../../lib/session";
import { bareAgentId, isStaleWatch, waitLine, watchSubject } from "@server/shared/watch";
import { plainStatus } from "@shared/statusWords";
import { Button } from "../../components/ui/button";
import { TooltipProvider } from "../../components/ui/tooltip";
import { isTurnHeld, isTurnPaused, turnElapsed, useClock, useSlowClock } from "../../lib/turnClock";
import { duration } from "../../lib/duration";
import { threadStatus } from "../../lib/threadStripModel";
import { useTurnState, type TurnSession } from "../turnState";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { storeTitleOf, threadMentionsToTitles, useTitlesOf } from "../../lib/threadMentions";
import { openWaitOf, waitIds } from "../agentSteps";
import { awaitsUser, needsApproval, turnCopyText } from "../transcriptActivity";
import { turnEndsStopped } from "../../lib/turnOutcome";
import { SwapIcon } from "../../motion/IconSwap";
import { IconAction, useArmOnIntent } from "./IconAction";
import { spanWords } from "./thinking";
import { useTurnRevealing } from "../revealDrain";
import { LINE, TurnLine } from "./WorkingLine";

/** A turn's closing row: the working line while the turn is live
 *  (`TurnLine`, which says an open wait as "Waiting on <title>": folded away
 *  while the turn is paused and while a step waits on the person, whose card
 *  says so, and back in the same element after), which becomes its duration
 *  line once it is over ("Worked" until the duration lands; "Stopped" the
 *  moment the person stops it, before the host settles the turn: the stopped
 *  error row draws nothing, open or settled); the live state while it runs or waits where no timer
 *  sits above a composer (`liveState`, the fleet's agent detail); and a
 *  watching line under the last settled turn while the thread watches, on
 *  every surface; `onOpenActivity` makes that line open the Activity
 *  section. */
export function TurnEnd({
  turn,
  cwd,
  harnessOf,
  turnState,
  liveState = true,
  onOpenActivity,
  onSaveNote,
  onSecondOpinion,
  onHandoff,
}: {
  turn: TurnInfo;
  cwd?: string;
  harnessOf: (turn: Block[]) => HarnessId | undefined;
  turnState: TurnSession | null;
  liveState?: boolean;
  onOpenActivity?: () => void;
  onSaveNote?: (text: string) => void;
  onSecondOpinion?: SecondOpinionHandler;
  onHandoff?: HandoffHandler;
}) {
  const { settled, durationMs, isLast } = turn;
  // Paused, or queued before it ran: no working line, nothing reads as running.
  const paused = turnState ? isTurnHeld(turnState) : false;
  // A Stop closes the turn at once: the line says Stopped before the host settles it.
  const stopped = useMemo(
    () => turnEndsStopped(turnState ?? { blocks: turn.blocks, status: "idle", thread: undefined }, turn.blocks),
    [turnState, turn.blocks],
  );
  // Over on the host (settled, or stopped), but text of the turn still being
  // revealed: the working line keeps its mark until it is all shown, and
  // only then morphs into the closing line (revealDrain.ts).
  const over = settled || stopped || turn.blocks.some((b) => b.stopped);
  const draining = useTurnRevealing(turn.id) && over;
  // Held: paused, or a step waits on the person (its card says so). The line folds away and comes back.
  const held = !over && (paused || turn.blocks.some(awaitsUser));
  // Settled only: the live turn's harness is not known until it answers.
  const fromHarness = useMemo(
    () => (settled ? harnessOf(turn.blocks) : undefined),
    [settled, harnessOf, turn.blocks],
  );
  // An open wait is the turn's state, said on the working line, never a row of its own.
  const wait = settled || paused ? null : openWaitOf(turn.blocks);
  const ids = useMemo(() => (wait ? waitIds(wait) : NO_AGENTS), [wait]);
  const titleOf = useTitlesOf(useMemo(() => [...new Set(ids.flatMap((id) => [id, bareAgentId(id)]))], [ids]));
  const [armed, intent] = useArmOnIntent();
  // Over, with its duration still to land: "Worked", which the time fills in.
  const pending = settled && !stopped && durationMs == null;
  const closes = !draining && (stopped || pending || (settled && durationMs != null));
  const output = settled && !pending ? threadMentionsToTitles(turnCopyText(turn.blocks), storeTitleOf) : "";
  return (
    <>
      <TurnLine
        live={draining || (!over && !held)}
        held={held}
        draining={draining}
        turn={turn.blocks}
        activity={turnState?.activity}
        cwd={cwd}
        waitWords={wait ? waitLine(ids, titleOf) : null}
        closing={
          closes
            ? {
                words: <ClosingWords elapsedMs={durationMs ?? null} stopped={stopped} />,
                pending,
                intent,
                actions: (
                  <ClosingActions
                    armed={armed}
                    copyText={output}
                    onSaveNote={onSaveNote}
                    fromHarness={fromHarness}
                    onSecondOpinion={onSecondOpinion ? (target, model) => onSecondOpinion(target, turn.blocks, model) : undefined}
                    onHandoff={onHandoff ? (target, model) => onHandoff(target, turn.blocks, model) : undefined}
                  />
                ),
              }
            : null
        }
      />
      {/* Kept folds: each opens and closes on .collapsible-auto, never mounting or unmounting a line on screen. */}
      {liveState && isLast ? (
        <KeptFold open={!settled}>
          <LiveTurnDuration turn={turn.blocks} active={!settled} />
        </KeptFold>
      ) : null}
      {isLast && turnState ? <WatchingFold session={turnState} watching={settled && isWatching(turnState)} onOpen={onOpenActivity} /> : null}
    </>
  );
}

/**
 * The live state of the turn still in flight. Ticks on the shared clock
 * so only this row re-renders each second, never the transcript.
 */
export function LiveTurnDuration({ turn, active = true }: { turn: Block[]; active?: boolean }) {
  const session = useTurnState();
  const paused = session ? isTurnPaused(session) : false;
  // Queued before it ran: the word, no clock (the fleet's agent detail draws this row; a pane has the strip).
  const queued = session?.status === "queued";
  const shown = usePaneVisible();
  const now = useClock(active && !paused && !queued && shown);
  const elapsed = session ? turnElapsed(session, now) : null;
  const waiting = turn.some(
    (b) => needsApproval(b) || (b.question != null && b.question.answers === undefined),
  );
  return (
    <TurnDuration elapsedMs={elapsed} live waiting={waiting} paused={paused} queued={queued} />
  );
}

/** The working line while the turn waits on its agents, re-worded as their titles land. */
function isWatching(session: TurnSession): boolean {
  return threadStatus({ status: session.status, background: session.background, activity: session.activity }).state === "watching";
}

/** The watching line in a kept fold under the last settled turn: it opens and
 *  closes on .collapsible-auto as the thread starts and stops watching, and
 *  its clocks run only while it is open. */
function WatchingFold({ session, watching, onOpen }: { session: TurnSession; watching: boolean; onOpen?: () => void }) {
  return (
    <KeptFold open={watching}>
      <WatchingTail session={session} active={watching} onOpen={onOpen} />
    </KeptFold>
  );
}

/** A line that comes and goes under the turn: nothing until it first opens
 *  (history draws none), then one fold for the rest of the mount, opening and
 *  closing on .collapsible-auto, so the line on screen is never unmounted and
 *  mounted again. */
function KeptFold({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Collapsible open={open}>
      <CollapsibleContent keepMounted className="collapsible-auto">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The watching line for a thread, naming what it watches (one subagent by
 *  title), amber once its own watch passes `STALE_WATCH_MS`. */
function WatchingTail({ session, active, onOpen }: { session: TurnSession; active: boolean; onOpen?: () => void }) {
  const since = active ? (session.background?.watchingSince ?? null) : null;
  const shown = usePaneVisible();
  const now = useSlowClock(since != null && shown);
  const stale = now > 0 && isStaleWatch({ status: session.status ?? "idle", background: session.background }, now);
  const titleOf = useTitlesOf(session.background?.agents ?? NO_AGENTS);
  return <WatchingLine since={since} stale={stale} onOpen={onOpen} subject={watchSubject(session.background, titleOf)} />;
}

const NO_AGENTS: string[] = [];

/**
 * A settled turn's thread still watching its background work or its
 * subagents: the word, what it watches ("Review the perf pass", "3
 * subagents") and the stretch's age, ticking every second like the closing
 * line's timer (one element per transcript, gated on the pane being shown),
 * the age amber when `stale`. The Activity section has the whole list, which the line
 * opens when given `onOpen`.
 */
export function WatchingLine({
  since,
  stale = false,
  onOpen,
  subject,
}: {
  since: number | null;
  stale?: boolean;
  onOpen?: () => void;
  /** What the thread watches, in the watch words (shared/watch.ts `watchSubject`). */
  subject?: string;
}) {
  const shown = usePaneVisible();
  const now = useClock(since != null && shown);
  const said = plainStatus(STATUS_WORD.watching, subject ?? null);
  const body = (
    <>
      <StatusMark state="watching" detail={subject} className="min-w-0 text-[13px]" />
      {since != null && now > 0 ? (
        <span aria-hidden className={cn(stale && "text-warning")}>
          {duration(Math.max(0, now - since))}
        </span>
      ) : null}
    </>
  );
  return (
    <div role="status" aria-label={said} className={LINE}>
      {onOpen ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onOpen}
          aria-label={`${said}, open Activity`}
          className="-ml-2 min-w-0 shrink gap-1 text-[13px] font-normal text-muted-foreground hover:text-foreground"
        >
          {body}
        </Button>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * A turn's closing line. Settled: "Worked for 2m 4s", or "Stopped" for a
 * turn the person stopped, then copy, save as note, hand off and second
 * opinion, shown on the line's hover or keyboard focus. Live: the state in
 * StatusMark's words, with the time where it means something.
 */
export function TurnDuration({
  elapsedMs,
  live = false,
  done = false,
  stopped = false,
  waiting = false,
  paused = false,
  queued = false,
  copyText: output,
  onSaveNote,
  fromHarness,
  onSecondOpinion,
  onHandoff,
}: {
  elapsedMs: number | null;
  live?: boolean;
  done?: boolean;
  /** Settled on the person's Stop: the line says so instead of the time. */
  stopped?: boolean;
  waiting?: boolean;
  /** Frozen mid-turn: the elapsed time holds. */
  paused?: boolean;
  /** Waiting for its turn to start: the word alone. */
  queued?: boolean;
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
        <ClosingWords elapsedMs={elapsedMs} stopped={stopped} />
        <ClosingActions
          armed={armed}
          copyText={output}
          onSaveNote={onSaveNote}
          fromHarness={fromHarness}
          onSecondOpinion={onSecondOpinion}
          onHandoff={onHandoff}
        />
      </div>
    );
  }
  const state = queued ? "queued" : paused ? "paused" : waiting ? "waiting" : "working";
  // One line through every state: the glyph cross-fades in its box, the word morphs.
  return (
    <div role={live ? "status" : undefined} aria-label={STATUS_WORD[state]} className={LINE}>
      <StatusMark state={state} word={false} className="me-1" />
      <MorphText state={state}>
        <span className={cn("font-medium", statusToneClass(state))}>{STATUS_WORD[state]}</span>
      </MorphText>
      {state === "working" && elapsedMs != null ? <span aria-hidden>{spanWords(elapsedMs)}</span> : null}
      {state === "paused" && elapsedMs != null ? <span aria-hidden>worked {spanWords(elapsedMs)}</span> : null}
    </div>
  );
}

/** The closing line's words: "Worked for 2m 4s", or Stopped. */
function ClosingWords({ elapsedMs, stopped }: { elapsedMs: number | null; stopped: boolean }) {
  return stopped ? <StatusMark state="stopped" className="text-[13px] font-normal" /> : <span>{formatWorkingDuration(elapsedMs, true)}</span>;
}

/** Copy, save as note, hand off and second opinion, shown on the line's hover or keyboard focus. */
function ClosingActions({
  armed,
  copyText: output,
  onSaveNote,
  fromHarness,
  onSecondOpinion,
  onHandoff,
}: {
  armed: boolean;
  copyText?: string;
  onSaveNote?: (text: string) => void;
  fromHarness?: HarnessId;
  onSecondOpinion?: (harness: HarnessId, model: string) => void;
  onHandoff?: (harness: HarnessId, model: string) => void;
}) {
  return (
    <span className={`ms-1 flex items-center ${reveal("turnend")} has-aria-expanded:opacity-100`}>
      {/* One provider: moving to a neighbour moves the label instead of waiting again. */}
      <TooltipProvider>
        {output ? <CopyTurnButton text={output} armed={armed} /> : null}
        {output && onSaveNote ? <SaveNoteButton text={output} onSave={onSaveNote} armed={armed} /> : null}
        {fromHarness && onHandoff ? <HandoffButton from={fromHarness} onPick={onHandoff} armed={armed} /> : null}
        {fromHarness && onSecondOpinion ? <SecondOpinionButton from={fromHarness} onPick={onSecondOpinion} armed={armed} /> : null}
      </TooltipProvider>
    </span>
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
            timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
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
