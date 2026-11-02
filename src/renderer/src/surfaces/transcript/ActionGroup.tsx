// A7 (turn structure): one run of actions, a line that opens onto its rows.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useReducedMotion } from "motion/react";
import { Bot, ChevronRight, Sparkles, type IconComponent } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent } from "../../components/ui/collapsible";
import { TextShimmer } from "../../components/ui/text-shimmer";
import type { Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { useLiveEdits } from "../../lib/tcserver/store";
import { useTitlesOf } from "../../lib/threadMentions";
import { DUR, FOLD_HOLD_MS } from "../../lib/ease";
import { SwapText } from "../../motion/SwapText";
import { useCountUp } from "../../motion/useCountUp";
import { usePersistedOpen } from "../editOpenState";
import { appThreadIds } from "../appTool";
import { ReconnectChip, reauthOf } from "../ToolChips";
import { GROUP_WINDOW } from "../transcriptRows";
import { useTranscriptSession } from "../transcriptSession";
import {
  actionGroupOf,
  awaitsUser,
  isThinkingBlock,
  isToolBlock,
  thoughtEndTs,
  toolCategory,
  type ActionGroupKind,
} from "../transcriptActivity";
import { actionOf } from "./actionModel";
import { ActivityRow } from "./ActivityRow";
import { Counts } from "./Counts";
import { GroupHandContext } from "./groupHand";
import { GLYPH } from "./ToolGlyph";
import type { ApprovalHandler } from "./types";

/** The threads a step names: an app call's, a report's or a spawn row's agent. */
function stepThreadIds(block: Block): string[] {
  if (block.agent) return [block.agent.id];
  return isToolBlock(block) ? appThreadIds(block) : [];
}

/** The line's glyph: the row glyph of the run's first call of its dominant kind, so a line and its rows show one icon per act; agent work leads with Bot. */
function lineGlyph(blocks: Block[], kind: ActionGroupKind, cwd?: string): IconComponent {
  if (kind === "agents") return Bot;
  const lead = blocks.find((b) => isToolBlock(b) && toolCategory(b) === kind);
  return lead ? GLYPH[actionOf(lead, cwd).glyph] : Sparkles;
}

/**
 * Whether a group's work is still on: while `working`, and for
 * FOLD_HOLD_MS after it stops, so the last step's settle shows before the
 * group folds. Decided during render, so the frame `working` turns false on
 * never starts a fold.
 */
function useFoldHold(working: boolean): boolean {
  const [held, setHeld] = useState(false);
  const [was, setWas] = useState(working);
  if (was !== working) {
    setWas(working);
    setHeld(!working);
  }
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), FOLD_HOLD_MS);
    return () => clearTimeout(timer);
  }, [held]);
  return working || held;
}

/**
 * Everything the agent did between two paragraphs. One call, with any
 * thoughts around it, or thoughts alone, are their own rows at the prose's
 * edge. More is one muted line, led by the glyph of the work it did most
 * ("Created diag.ts, ran a command  +46"), its rows hung 22px under its
 * words with no box and no rules. A lone call and a group are one tree, so
 * the second call's arrival remounts nothing.
 *
 * While the turn works in it (`working`), the group opens on its own once it
 * holds two calls: the line folds open above the first row and the rows
 * glide into their hang. It shows its newest GROUP_WINDOW rows, the oldest
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
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  cwd?: string;
  live?: boolean;
  /** The open turn works in this group (transcriptRows.ts `working`). */
  working?: boolean;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const sessionId = useTranscriptSession() ?? "";
  // Only the live run reads the server's live diffs; a settled one has its counts.
  const liveEdits = useLiveEdits(live ? sessionId : "");
  // The line names the threads its agent calls and reports are about; it re-words as their titles land.
  const ids = useMemo(() => blocks.flatMap(stepThreadIds), [blocks]);
  const titleOf = useTitlesOf(ids);
  const titles = ids.map((id) => titleOf(id) ?? "").join("|");
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

  // The rows a person has seen: those at mount, and every row when they open
  // the group by hand. Any other row landed while it was open, and rises in.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(blocks.map((b) => b.id)));
  const [handOpen, setHandOpen] = useState(saved === true);
  if ((saved === true) !== handOpen) {
    setHandOpen(saved === true);
    if (saved === true) setSeen(new Set(blocks.map((b) => b.id)));
  }

  // The newest GROUP_WINDOW rows while the group runs on its own; every row
  // once a hand decided it. A row leaving the top stays mounted, clipped, until
  // the list's glide ends (`useWindowGlide`).
  const listRef = useRef<HTMLDivElement>(null);
  const from = auto && !lone ? Math.max(0, blocks.length - GROUP_WINDOW) : 0;
  const shownFrom = useWindowGlide(listRef, blocks, from, reduce);
  useHangGlide(listRef, lone, auto && open, reduce);

  const rows = blocks.slice(shownFrom).map((block, index) => (
    <div key={block.id} data-step={block.id} className={seen.has(block.id) ? "min-w-0" : "step-land min-w-0"}>
      <ActivityRow
        block={block}
        cwd={cwd}
        live={live}
        expanded
        endTs={isThinkingBlock(block) ? thoughtEndTs(blocks, shownFrom + index) : undefined}
        onApproval={onApproval}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    </div>
  ));

  return (
    <GroupHandContext.Provider value={decide}>
      <div className="flex min-w-0 flex-col">
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
                className="group/line h-7 w-fit min-w-0 justify-start gap-2 rounded-md px-0 font-sans text-[13px] font-normal leading-5 text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent active:not-aria-[haspopup]:scale-100 aria-expanded:bg-transparent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <span data-kind={group.kind} className="flex shrink-0">
                  <Glyph className="size-3.5" strokeWidth={1.5} aria-hidden />
                </span>
                {/* The phrase changes tense in place when the run settles; a count
                    that grows under one tense never animates. */}
                <SwapText state={live ? "live" : "settled"} className="min-w-0 truncate">
                  {live ? <TextShimmer>{group.phrase}</TextShimmer> : group.phrase}
                </SwapText>
                <Counts added={adds} removed={dels} failed={group.failed} />
                <ChevronRight
                  aria-hidden
                  className={`size-3 shrink-0 transition-transform duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                  strokeWidth={1.5}
                />
              </Button>
              {reauth ? <ReconnectChip reauth={reauth} /> : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
        {/* The rows: one list, the same parent for a lone call and a group,
            so the second call's arrival remounts nothing. */}
        <Collapsible open={open}>
          <CollapsibleContent id={panelId} className={auto ? "collapsible-auto" : undefined}>
            <div ref={listRef} data-group-rows className={lone ? "flex min-w-0 flex-col" : "flex min-w-0 flex-col pl-5.5"}>
              {rows}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
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
    if (from <= shown) return;
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
    const end = () => {
      list.style.transition = "";
      list.style.marginTop = "";
      setShown(from);
    };
    list.addEventListener("transitionend", end, { once: true });
    // A list that never paints a transition (a hidden pane) ends on time.
    const timer = setTimeout(end, DUR.base * 1000 + 50);
    return () => {
      clearTimeout(timer);
      list.removeEventListener("transitionend", end);
    };
  }, [listRef, from, shown, reduce]);
  return Math.min(shown, from);
}

/**
 * The rows gliding 22px from the prose's edge into their hang when a lone
 * call becomes a group while it works on its own, on the layout spring; the
 * transform comes off when it ends. Nothing moves at mount.
 */
function useHangGlide(listRef: RefObject<HTMLDivElement | null>, lone: boolean, auto: boolean, reduce: boolean): void {
  const [wasLone, setWasLone] = useState(lone);
  const [glide, setGlide] = useState(false);
  if (wasLone !== lone) {
    setWasLone(lone);
    setGlide(wasLone && !lone && auto && !reduce);
  }
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!glide || !list) return;
    list.style.transition = "none";
    list.style.transform = "translateX(-22px)";
    void list.offsetHeight;
    list.style.transition = "transform var(--dur-layout) var(--ease-layout)";
    list.style.transform = "";
    const end = () => {
      list.style.transition = "";
      setGlide(false);
    };
    list.addEventListener("transitionend", end, { once: true });
    return () => list.removeEventListener("transitionend", end);
  }, [listRef, glide]);
}
