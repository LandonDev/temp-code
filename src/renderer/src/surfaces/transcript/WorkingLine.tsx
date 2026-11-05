// UI-16: the live turn's one working line, and the closing line it becomes.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent } from "../../components/ui/collapsible";
import { WorkingMark } from "../../components/ui/working-mark";
import { WorkingText } from "../../components/ui/working-text";
import { cn } from "../../lib/cn";
import { DUR, EASE_SWAP_CSS, FADE_OUT, SPRING_LAYOUT } from "../../lib/ease";
import { useHeldPhase } from "../../lib/heldWord";
import type { Block } from "../../lib/session";
import { useLiveEdits } from "../../lib/tcserver/store";
import type { TitleOf } from "../../lib/threadMentions";
import { MorphText } from "../../motion/MorphText";
import { useCountUp } from "../../motion/useCountUp";
import { isEditBlock } from "../editModel";
import { ToolDetails } from "../ToolDetails";
import { actionGroupOf } from "../transcriptActivity";
import { useTranscriptSession } from "../transcriptSession";
import { actionOf } from "./actionModel";
import { BODY_FRAME } from "./ActionRow";
import { CommandCard } from "./CommandCard";
import { Counts } from "./Counts";
import { setOpenedLive } from "./workingOpen";
import { workingPhase, type WorkingPhase } from "./workingPhase";

/** A line of the transcript: 28px, 13px on 20px, muted. Its words, details,
 *  counts and times sit 4px apart; a glyph keeps 8px to the first word
 *  (StatusMark's own) and a chevron or the hover actions 8px after the last. */
export const LINE = "flex h-7 items-center gap-1 font-sans text-[13px] leading-5 tabular-nums text-muted-foreground";

const MARK_IN = { opacity: 0, transform: "scale(0.25)" };
const MARK_SHOWN = { opacity: 1, transform: "scale(1)", transition: SPRING_LAYOUT };
const MARK_OUT = { opacity: 0, transform: "scale(0.25)", transition: FADE_OUT.transition };

const samePhase = (a: WorkingPhase, b: WorkingPhase) =>
  a.key === b.key &&
  a.words === b.words &&
  a.call?.block === b.call?.block &&
  a.thought?.line === b.thought?.line &&
  a.thought?.key === b.thought?.key;

/** The settled turn's closing line, as TurnEnd hands it over. `pending`: the
 *  turn is over but its duration has not landed ("Worked"): drawn only by a
 *  line that was live in this mount, which morphs into it and lets the time
 *  fill in under the same key; a line that mounts on it draws nothing yet. */
export type Closing = { words: ReactNode; actions: ReactNode; intent?: Record<string, unknown>; pending?: boolean };

/**
 * A turn's last line, one element from Send to the turn's end. While the
 * turn is live (`live`): the working mark in the glyph slot, then words that
 * morph with the work (`workingPhase`, each phase held 300 ms): Sending, the
 * host's words for the wait, Thinking and then the thought's newest sentence
 * in its place (each sentence its own phase, so one morphs into the next and
 * a long one ends in an ellipsis at the row's edge), the running
 * call ("Reading format.ts", its live counts for an edit, a chevron that
 * opens a command's or a tool's body under the line), the mark alone while
 * prose streams. When the turn settles in front of the person the mark
 * leaves as an icon does, the words morph to the closing line ("Worked for
 * 2m 4s", or Stopped) and slide from the glyph slot to the prose edge, and
 * the closing line's hover actions mount. A line that mounts settled draws
 * the closing line at once.
 *
 * Once live in this mount the line is never unmounted and never keyed: while
 * the turn is `held` (paused, or a step waits on the person, whose card says
 * so) it folds closed on `.collapsible-auto` with its words as they were, and
 * a resume reopens the same element; a Stop morphs it to Stopped at once; a
 * turn over before its duration lands says "Worked" and the time fills in.
 * A line never live and with no closing draws nothing.
 */
/** The phase while the turn is over but its text still reveals: the mark alone, as under streaming prose. */
const DRAINING: WorkingPhase = { key: "writing", words: "" };

export function TurnLine({
  live,
  held = false,
  draining = false,
  turn,
  activity,
  cwd,
  titleOf,
  waitWords,
  closing,
}: {
  live: boolean;
  /** Paused, or a step waits on the person: the line folds away, its words kept. */
  held?: boolean;
  /** Over on the host, its text still revealing: the mark alone until it is all shown. */
  draining?: boolean;
  turn: Block[];
  activity?: string | null;
  cwd?: string;
  titleOf?: TitleOf;
  waitWords?: string | null;
  closing: Closing | null;
}) {
  const reduce = useReducedMotion() === true;
  const sessionId = useTranscriptSession() ?? "";
  const next = useMemo(
    () => (draining ? DRAINING : workingPhase(turn, activity, { cwd, titleOf, waitWords })),
    [draining, turn, activity, cwd, titleOf, waitWords],
  );
  const phase = useHeldPhase(next, samePhase);
  const call = live ? phase.call : undefined;
  const action = call ? actionOf(call.block, cwd, null, true) : undefined;
  // A command or a tool opens its body under the line; an edit ticks its counts instead.
  const hasBody = action?.opens === "command" || action?.opens === "details";
  const [openId, setOpenId] = useState<string | null>(null);
  const bodyOpen = hasBody && !!call && openId === call.block.id;

  // One running edit ticks its counts on the line, as its row did.
  const edit = call && isEditBlock(call.block) ? call.block : undefined;
  const liveEdits = useLiveEdits(edit ? sessionId : "");
  const counts = edit ? actionGroupOf([edit], { cwd, live: true, liveEdits }) : undefined;
  const adds = useCountUp(counts?.adds ?? 0, !!edit);
  const dels = useCountUp(counts?.dels ?? 0, !!edit);

  // Live once in this mount: the line stays, and a pending closing ("Worked") is drawn.
  const [everLive, setEverLive] = useState(live);
  if (live && !everLive) setEverLive(true);
  // The settle the person watched: the words slide home from the glyph slot.
  const closed = !live && !held;
  const [wasClosed, setWasClosed] = useState(closed);
  const [slide, setSlide] = useState(false);
  if (wasClosed !== closed) {
    setWasClosed(closed);
    setSlide(!wasClosed && closed && everLive && !reduce);
  }
  const words = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = words.current;
    if (!slide || !el || typeof el.animate !== "function") return undefined;
    const animation = el.animate([{ transform: "translateX(22px)" }, { transform: "translateX(0px)" }], {
      duration: DUR.base * 1000,
      easing: EASE_SWAP_CSS,
    });
    animation.onfinish = () => setSlide(false);
    return () => animation.cancel();
  }, [slide]);

  const shownClosing = closing && (!closing.pending || everLive) ? closing : null;
  if (!everLive && !shownClosing) return null;
  // Still saying the phase: live, or held with its words as they were.
  const phased = live || (held && !shownClosing);

  const toggle = () => {
    if (!call) return;
    const open = !bodyOpen;
    setOpenId(open ? call.block.id : null);
    setOpenedLive(call.block.id, open);
  };

  return (
    <Collapsible open={!held && (live || !!shownClosing)} data-slot="turn-line" className="flex min-w-0 flex-col">
      <CollapsibleContent keepMounted className="collapsible-auto">
      <div
        role={live ? "status" : undefined}
        aria-label={live ? phase.spoken ?? (phase.words || "Working") : undefined}
        className={cn(LINE, "group/turnend relative min-w-0")}
        {...(live ? undefined : closing?.intent)}
      >
        {hasBody ? (
          <Button
            variant="ghost"
            aria-label={phase.words}
            aria-expanded={bodyOpen}
            onClick={toggle}
            className="absolute inset-0 h-auto rounded-md hover:bg-transparent active:bg-transparent aria-expanded:bg-transparent"
          />
        ) : null}
        <AnimatePresence initial={false}>
          {live ? (
            <motion.span key="mark" className="pointer-events-none absolute inset-y-0 left-0 flex items-center" initial={reduce ? { opacity: 0 } : MARK_IN} animate={reduce ? { opacity: 1 } : MARK_SHOWN} exit={reduce ? FADE_OUT : MARK_OUT}>
              <WorkingMark />
            </motion.span>
          ) : null}
        </AnimatePresence>
        <div ref={words} data-turn-words className={cn("flex min-w-0 items-center gap-1", hasBody && "pointer-events-none", phased && "pl-5.5")}>
          {/* A call's counts and chevron are its words': they leave and arrive with them. */}
          <MorphText state={phased ? phase.key : "closed"} className="min-w-0">
            {phased ? (
              <span className="flex min-w-0 items-center gap-1">
                <PhaseWords phase={phase} />
                {edit && (adds || dels) ? <Counts added={adds} removed={dels} /> : null}
                {hasBody ? (
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "ms-1 size-3 shrink-0 transition-[rotate,color] duration-(--dur-base) ease-(--ease-out) group-hover/turnend:text-foreground motion-reduce:transition-none",
                      bodyOpen && "rotate-90",
                    )}
                  />
                ) : null}
              </span>
            ) : (
              shownClosing?.words
            )}
          </MorphText>
          {phased ? null : shownClosing?.actions}
        </div>
      </div>
      </CollapsibleContent>
      {hasBody && call && action ? (
        <Collapsible open={bodyOpen}>
          <CollapsibleContent>
            <div className="pb-2 pl-5.5">
              <div data-row-body className={BODY_FRAME}>
                {action.opens === "command" ? <CommandCard block={call.block} failed={false} /> : <ToolDetails block={call.block} />}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </Collapsible>
  );
}

/** The phase's words in the shimmer: one call's verb muted and object in foreground. */
function PhaseWords({ phase }: { phase: WorkingPhase }) {
  if (!phase.words) return null;
  if (phase.call) {
    return (
      <WorkingText words={phase.words}>
        {phase.call.verb}
        {phase.call.object ? (
          <>
            {" "}
            <span className="text-foreground">{phase.call.object}</span>
          </>
        ) : null}
      </WorkingText>
    );
  }
  return <WorkingText>{phase.words}</WorkingText>;
}
