// A7 (turn structure): one run of actions, a line that opens onto its rows.
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useReducedMotion } from "motion/react";
import { Bot, ChevronRight, Sparkles, type IconComponent } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent } from "../../components/ui/collapsible";
import { DISCLOSURE_CHEVRON } from "../../components/ui/disclosure";
import { cn } from "../../lib/cn";
import type { Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { useLiveEdits } from "../../lib/tcserver/store";
import { useTitlesOf } from "../../lib/threadMentions";
import { DUR, SPRING_LAYOUT_CSS, STAGGER } from "../../lib/ease";
import { useHeightGlide } from "../../lib/heightGlide";
import { useFoldHold } from "../../lib/foldHold";
import { SwapIcon } from "../../motion/IconSwap";
import { MorphText } from "../../motion/MorphText";
import { useCountUp } from "../../motion/useCountUp";
import { usePersistedOpen } from "../editOpenState";
import { appThreadIds } from "../appTool";
import { isWaitCall, spawnedNames, waitOutcomes } from "../agentSteps";
import { bareAgentId } from "@shared/watch";
import { ReconnectChip, reauthOf } from "../ToolChips";
import { GROUP_WINDOW } from "../transcriptRows";
import { useTranscriptSession } from "../transcriptSession";
import {
  actionGroupOf,
  awaitsUser,
  isThinkingBlock,
  isToolBlock,
  toldByWorkingLine,
  toolCategory,
  type ActionGroupKind,
} from "../transcriptActivity";
import { actionOf } from "./actionModel";
import { ActivityRow } from "./ActivityRow";
import { Counts } from "./Counts";
import { GroupHandContext, SpawnedNamesContext } from "./groupHand";
import { GLYPH } from "./ToolGlyph";
import type { ApprovalHandler } from "./types";

/** The threads a step names: an app call's, a report's or a spawn row's agent, the agents a wait returned on. */
function stepThreadIds(block: Block): string[] {
  if (block.agent) return [block.agent.id, bareAgentId(block.agent.id)];
  if (isWaitCall(block)) return waitOutcomes(block).flatMap((o) => [o.id, bareAgentId(o.id)]);
  return isToolBlock(block) ? appThreadIds(block) : [];
}

/** The line's glyph: the row glyph of the run's first call of its dominant kind, so a line and its rows show one icon per act; agent work leads with Bot. */
function lineGlyph(blocks: Block[], kind: ActionGroupKind, cwd?: string): IconComponent {
  if (kind === "agents") return Bot;
  const lead = blocks.find((b) => isToolBlock(b) && toolCategory(b) === kind);
  return lead ? GLYPH[actionOf(lead, cwd).glyph] : Sparkles;
}

/**
 * Everything the agent did between two paragraphs. One call is its own row
 * at the prose's edge. More is one muted line, led by the glyph of the work
 * it did most ("Created diag.ts, ran a command +46"), its rows in a table
 * under it, as Claude's: one hairline frame with a 12px radius across the
 * column, a 32px row per step with a rule between two. A lone call and a
 * group are one tree, so the second call's arrival remounts nothing.
 *
 * Thoughts are no rows: a thought streaming is the turn's working line, and
 * a settled one shows only in a group opened by hand, as "Thought". While
 * the turn is open a running call is no row either (`toldByWorkingLine`):
 * the working line under the turn says it, and it lands here as a
 * past-tense row once it settles. The line's phrase, counts and whether the
 * run is lone are over every step, running ones included, so the group
 * opens at two calls and names them all. A run that shows no row and is
 * lone draws nothing.
 *
 * While the turn works in it (`working`), the group opens on its own once it
 * holds two calls: the line folds open above the first row, the rows glide
 * to the table's inset and its frame fades in. It shows its newest GROUP_WINDOW rows, the oldest
 * leaving the top as the list glides up; a row that lands fades in and
 * rises. When the work moves on it waits FOLD_HOLD_MS and folds. A person's
 * hand (the line, or a row's body) decides the group from then on, and a
 * group opened by hand shows every row. A step waiting on the person keeps
 * it open. Mounted working it shows open with no motion; mounted settled,
 * closed.
 */
export function ActionGroup({
  blocks,
  cwd,
  live = false,
  working = false,
  settled = true,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  cwd?: string;
  live?: boolean;
  /** The open turn works in this group (transcriptRows.ts `working`). */
  working?: boolean;
  /** The group's turn is over (transcriptRows.ts `TurnInfo.settled`): its running calls draw as rows. */
  settled?: boolean;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const sessionId = useTranscriptSession() ?? "";
  // Only the live run reads the server's live diffs; a settled one has its counts.
  const liveEdits = useLiveEdits(live ? sessionId : "");
  // The line names the threads its agent calls and reports are about; it re-words as their titles land.
  const ids = useMemo(() => blocks.flatMap(stepThreadIds), [blocks]);
  const storeTitle = useTitlesOf(ids);
  const titles = ids.map((id) => storeTitle(id) ?? "").join("|");
  // An agent the store has not listed is named by what its spawn in this run called it.
  const names = useMemo(() => spawnedNames(blocks), [blocks]);
  const titleOf = useCallback((id: string) => storeTitle(id) ?? names.get(id)?.title, [storeTitle, names]);
  const group = useMemo(
    () => actionGroupOf(blocks, { cwd, live, liveEdits: live ? liveEdits : undefined, titleOf }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `titles` is what changes when titleOf's answers do
    [blocks, cwd, live, liveEdits, titleOf, titles],
  );
  const [saved, setSaved] = usePersistedOpen(`${sessionId}:a:${blocks[0]?.id}`);
  const adds = useCountUp(group.adds, live);
  const dels = useCountUp(group.dels, live);
  const reduce = useReducedMotion() === true;
  const panelId = useId();

  const lone = group.lone;
  const auto = saved === null;
  const on = useFoldHold(working);
  // A step still waiting on the person keeps the list open whatever was chosen.
  const open = lone || blocks.some(awaitsUser) || (auto ? on : saved);
  const reauth = open ? undefined : reauthOf(blocks);
  const Glyph = lineGlyph(blocks, group.kind, cwd);
  const decide = useCallback(() => {
    if (saved === null) setSaved(true);
  }, [saved, setSaved]);
  const toggle = () => setSaved(!open);

  // The rows it draws: thoughts only once a hand opened it, a running call
  // only once its turn is over.
  const shown = useMemo(
    () => blocks.filter((b) => (isThinkingBlock(b) ? saved === true && !b.streaming : settled || !toldByWorkingLine(b))),
    [blocks, saved, settled],
  );

  // The rows a person has seen: those shown at mount, and every row when they
  // open the group by hand. Any other row landed while it was open, a call
  // that settled among them, and rises in.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(shown.map((b) => b.id)));
  const [handOpen, setHandOpen] = useState(saved === true);
  if ((saved === true) !== handOpen) {
    setHandOpen(saved === true);
    if (saved === true) setSeen(new Set(shown.map((b) => b.id)));
  }

  // The newest GROUP_WINDOW rows while the group runs on its own; every row
  // once a hand decided it. A row leaving the top stays mounted, clipped, until
  // the list's glide ends (`useWindowGlide`).
  const listRef = useRef<HTMLDivElement>(null);
  const from = auto && !lone ? Math.max(0, shown.length - GROUP_WINDOW) : 0;
  const shownFrom = useWindowGlide(listRef, shown, from, reduce);
  const framing = useTableEntry(listRef, lone, auto && open, reduce);
  const visible = shown.slice(shownFrom);

  // The open table glides to its new height when the rows it shows change
  // (after the window's pull-up, so one row in and one out nets nothing),
  // its first row into a table of running calls included. A commit that also
  // folds it, turns a lone call into a table or is a hand's decision glides
  // nothing: those have motion of their own.
  const tableRef = useRef<HTMLDivElement>(null);
  useHeightGlide(tableRef, visible.map((b) => b.id).join("|"), {
    enabled: open && !lone,
    curve: "layout",
    hold: `${lone}|${open}|${saved}`,
  });

  // Rows that land in one commit fade in one after another, STAGGER.stepMs
  // apart, the fourth and later together. A row keeps its place in its batch.
  const [stagger, setStagger] = useState<ReadonlyMap<string, number>>(() => new Map(shown.map((b) => [b.id, 0])));
  const landing = visible.filter((b) => !stagger.has(b.id));
  if (landing.length > 0) {
    const next = new Map(stagger);
    landing.forEach((b, i) => next.set(b.id, Math.min(i, STAGGER.max)));
    setStagger(next);
  }

  if (lone && shown.length === 0) return null;

  const rows = visible.map((block) => (
    <div
      key={block.id}
      data-step={block.id}
      className={seen.has(block.id) ? "min-w-0" : "step-land min-w-0"}
      style={seen.has(block.id) ? undefined : ({ "--stagger": stagger.get(block.id) ?? 0 } as CSSProperties)}
    >
      <ActivityRow
        block={block}
        cwd={cwd}
        live={live}
        expanded
        onApproval={onApproval}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    </div>
  ));

  return (
    <GroupHandContext.Provider value={decide}>
      <SpawnedNamesContext.Provider value={names}>
      <div data-action-group className="flex min-w-0 flex-col">
        {/* The line: folded away while the run holds one call. */}
        <Collapsible open={!lone}>
          <CollapsibleContent keepMounted className="collapsible-auto">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                data-group-line
                aria-expanded={open}
                aria-controls={panelId}
                onClick={toggle}
                className="group/line h-7 w-fit min-w-0 justify-start gap-1 rounded-md px-0 font-sans text-[13px] font-normal leading-5 text-muted-foreground transition-none hover:bg-transparent hover:text-foreground active:bg-transparent aria-expanded:bg-transparent"
              >
                <span data-kind={group.kind} className="me-1 flex shrink-0">
                  {/* The glyph of the run's main kind; it swaps in place when that kind changes. */}
                  <SwapIcon state={group.kind}>
                    <Glyph className="size-3.5" aria-hidden />
                  </SwapIcon>
                </span>
                {/* The phrase changes tense in place when the run settles; a count
                    that grows under one tense never animates. The working line under
                    the turn is its one moving element, so the phrase holds still. */}
                <MorphText state={live ? "live" : "settled"} className="min-w-0">
                  {group.phrase}
                </MorphText>
                <Counts added={adds} removed={dels} failed={group.failed} />
                <ChevronRight
                  aria-hidden
                  className={cn("ms-1 size-3 shrink-0", DISCLOSURE_CHEVRON, open && "rotate-90")}
                />
              </Button>
              {reauth ? <ReconnectChip reauth={reauth} /> : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
        {/* The rows: one list in one frame, the same parents for a lone call
            and a group, so the second call's arrival remounts nothing. A
            group's rows sit in a table (stepLine.ts): a hairline frame with a
            12px radius, drawn over the rows' edges after the list (so the
            list keeps its place among the children), 32px rows with rules
            between them; the window's glide moves the rows inside the frame,
            which stays put and clips them. A lone call is a bare row. */}
        <Collapsible open={open}>
          <CollapsibleContent id={panelId} className={auto ? "collapsible-auto" : undefined}>
            <div ref={tableRef} data-table={lone ? undefined : ""} className={lone ? "flex min-w-0 flex-col" : "relative flex min-w-0 flex-col overflow-clip rounded-xl"}>
              <div ref={listRef} data-group-rows className={lone ? "flex min-w-0 flex-col" : "flex min-w-0 flex-col divide-y divide-border"}>
                {rows}
              </div>
              {lone ? null : (
                <span aria-hidden data-table-frame className={cn("pointer-events-none absolute inset-0 rounded-xl border border-border", framing && "table-frame-in")} />
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      </SpawnedNamesContext.Provider>
    </GroupHandContext.Provider>
  );
}

/**
 * The window's start, lagging `from` while the rows leaving the top glide
 * out: the list is pulled up by their measured height at once (so the
 * group holds its height) and glides there from where it was, over
 * --dur-base on --ease-out; when it ends they unmount. Showing more (a hand
 * open) or reduced motion moves the start at once.
 */
function useWindowGlide(
  listRef: RefObject<HTMLDivElement | null>,
  blocks: Block[],
  from: number,
  reduce: boolean,
): number {
  const [shown, setShown] = useState(from);
  if (from < shown) setShown(from);
  // Read at the glide's start: a streamed row re-rendering never restarts it.
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  useLayoutEffect(() => {
    const list = listRef.current;
    const blocks = blocksRef.current;
    // The leaving rows unmounted in this commit: the pull-up goes with them,
    // before the frame paints, so the group never shows them twice.
    if (from <= shown) {
      if (list) list.style.marginTop = "";
      return;
    }
    if (!list || reduce) {
      setShown(from);
      return;
    }
    let height = 0;
    for (const block of blocks.slice(shown, from)) {
      const row = list.querySelector<HTMLElement>(`:scope > [data-step="${CSS.escape(block.id)}"]`);
      height += row?.offsetHeight ?? 0;
    }
    if (height === 0) {
      setShown(from);
      return;
    }
    list.style.transition = "none";
    list.style.marginTop = `${-height}px`;
    list.style.transform = `translateY(${height}px)`;
    void list.offsetHeight;
    list.style.transition = "transform var(--dur-base) var(--ease-out)";
    list.style.transform = "";
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      list.style.transition = "";
      setShown(from);
    };
    // Only the list's own glide: a landing row's .step-land ends inside it and bubbles.
    const onEnd = (event: TransitionEvent) => {
      if (event.target === list && event.propertyName === "transform") end();
    };
    list.addEventListener("transitionend", onEnd);
    // A list that never paints a transition (a hidden pane) ends on time.
    const timer = setTimeout(end, DUR.base * 1000 + 50);
    return () => {
      clearTimeout(timer);
      list.removeEventListener("transitionend", onEnd);
    };
  }, [listRef, from, shown, reduce]);
  return Math.min(shown, from);
}

/**
 * A lone call becoming a group while it works on its own: the rows glide
 * 12px from the prose's edge to the table's inset on the layout spring, and
 * the table's frame fades in over --dur-base (`table-frame-in`, true while it
 * runs; under reduced motion the frame fades over --dur-fast and nothing
 * moves). The transform comes off when it ends. Nothing moves at mount: a
 * group that mounts settled, or reopens, draws its frame at once.
 */
function useTableEntry(listRef: RefObject<HTMLDivElement | null>, lone: boolean, auto: boolean, reduce: boolean): boolean {
  const [wasLone, setWasLone] = useState(lone);
  const [glide, setGlide] = useState(false);
  if (wasLone !== lone) {
    setWasLone(lone);
    setGlide(wasLone && !lone && auto);
  }
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!glide || !list) return;
    if (reduce) {
      const timer = setTimeout(() => setGlide(false), DUR.fast * 1000 + 50);
      return () => clearTimeout(timer);
    }
    list.style.transition = "none";
    list.style.transform = "translateX(-12px)";
    void list.offsetHeight;
    list.style.transition = "transform var(--dur-layout) var(--ease-layout)";
    list.style.transform = "";
    const end = () => {
      list.style.transition = "";
      setGlide(false);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === list && event.propertyName === "transform") end();
    };
    list.addEventListener("transitionend", onEnd);
    const timer = setTimeout(end, SPRING_LAYOUT_CSS.ms + 50);
    return () => {
      clearTimeout(timer);
      list.removeEventListener("transitionend", onEnd);
    };
  }, [listRef, glide, reduce]);
  return glide;
}
