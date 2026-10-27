// A7 (turn structure): zen phases, retired by the action group.
import {
  ChevronRight,
  Minus,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "../../chrome/icons";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ApprovalDecision } from "../../lib/harness";
import { Shimmer } from "../Shimmer";
import { usePersistedOpen } from "../editOpenState";
import { type Block } from "../../lib/session";
import { ReconnectChip, reauthOf } from "../ToolChips";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { splitEditCards } from "../editCards";
import { isEditBlock } from "../editModel";
import { useTranscriptSession } from "../transcriptSession";
import {
  activityPhaseTitle,
  buildActivityPhases,
  awaitsUser,
  needsApproval,
  nestedScrollAbsorbsWheel,
  type ActivityPhase,
  type ActivityPhaseKind,
} from "../transcriptActivity";
import { ActivityRow } from "./ActivityRow";

/**
 * Zen's activity view: the turn's work as phases. A phase is a run of related
 * calls under the line the agent wrote to introduce it — "now I need to find
 * the theme provider", then the searches and reads that followed. The phase
 * the agent is in stays open, with new steps scrolling inside a short window;
 * the moment it moves on the phase folds back to its header, so a long turn
 * ends up as a handful of labelled groups sitting above the answer.
 */
export function ActivityPhases({
  blocks,
  cwd,
  done,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  cwd?: string;
  done?: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const phases = useMemo(() => buildActivityPhases(blocks), [blocks]);

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {phases.map((phase, index) => (
        <ActivityPhaseGroup
          key={phase.id}
          phase={phase}
          cwd={cwd}
          active={!done && index === phases.length - 1}
          onApproval={onApproval}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

/**
 * Keep a live phase body on its newest step. Pinning happens in layout
 * before paint so the window follows without a visible hitch; only a real
 * wheel away from the bottom pauses that.
 */
export function useLivePhaseScroll(
  el: HTMLDivElement | null,
  enabled: boolean,
  steps: Block[],
) {
  const stickToBottom = useRef(true);
  const wasEnabled = useRef(false);

  useLayoutEffect(() => {
    if (!enabled) {
      wasEnabled.current = false;
      return;
    }
    if (!wasEnabled.current) {
      stickToBottom.current = true;
      wasEnabled.current = true;
    }
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [el, enabled, steps]);

  useEffect(() => {
    if (!el || !enabled) return;

    const pin = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      if (isNearBottom(el)) stickToBottom.current = true;
    };
    const onWheel = (e: WheelEvent) => {
      if (!nestedScrollAbsorbsWheel(el, e.deltaY)) return;
      if (e.deltaY < 0) stickToBottom.current = false;
      e.stopPropagation();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    const inner = el.firstElementChild;
    const observer = new ResizeObserver(pin);
    if (inner) observer.observe(inner);
    pin();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  }, [el, enabled]);
}

/**
 * One phase: a header the whole group hangs off, and the steps under it on a
 * rail. Folding is automatic — the group opens while it is the live one and
 * closes when the agent moves on — until you click, after which it stays where
 * you put it. A step still waiting on you keeps the group open regardless.
 * While live, the open body stays a short scrolling window pinned to the
 * newest step; after the turn settles an opened group is full height again.
 */
export function ActivityPhaseGroup({
  phase,
  cwd,
  active,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  phase: ActivityPhase;
  cwd?: string;
  active: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const sessionId = useTranscriptSession();
  const [override, setOverride] = usePersistedOpen(
    `${sessionId ?? "-"}:p:${phase.id}`,
  );
  const waiting = phase.steps.some(awaitsUser);
  // The live phase opens on its second step; a reader's choice is remembered.
  const open = waiting || (override ?? (active && phase.steps.length > 1));
  const [liveScroller, setLiveScroller] = useState<HTMLDivElement | null>(null);
  useLivePhaseScroll(liveScroller, active && open, phase.steps);
  const title = activityPhaseTitle(phase, active, cwd);
  // Edits outlive the fold: a closed group still shows what it changed, with
  // the counts, while the reads and searches around them stay tucked away.
  const edits = phase.steps.filter(
    (block) => isEditBlock(block) && !needsApproval(block) && !block.question,
  );

  // A lone call is not a group: a header repeating the single row under it
  // says nothing twice.
  if (phase.steps.length === 1) {
    return (
      <div className="flex min-w-0 items-start gap-1.5">
        <ActivityPhaseIcon kind={phase.kind} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <ActivityRow
            block={phase.steps[0]}
            cwd={cwd}
            variant="phase"
            live={active}
            onApproval={onApproval}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        </div>
      </div>
    );
  }

  const label = active ? (
    <Shimmer
      className="min-w-0 flex-1 truncate font-sans text-sm"
    >
      {title}
    </Shimmer>
  ) : (
    // Dimmed to sit with the icons: the work is chrome around the answer, and
    // only the answer reads at full strength.
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors group-hover:text-content/70">
      {title}
    </span>
  );

  const reauth = open ? undefined : reauthOf(phase.steps);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={
          open ? `Hide the steps for ${title}` : `Show the steps for ${title}`
        }
        onClick={() => setOverride(!open)}
        className="group flex w-full min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
      >
        {/*
         * The two icons share one 14px box, so the swap is instant: fading
         * between them leaves both half-drawn on top of each other.
         */}
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <ActivityPhaseIcon
            kind={phase.kind}
            className="group-hover:opacity-0"
          />
          <ChevronRight
            className={`absolute size-3.5 text-content/40 opacity-0 transition-transform duration-150 group-hover:opacity-100 ${
              open ? "rotate-90" : ""
            }`}
            strokeWidth={1.75}
          />
        </span>
        {label}
      </button>
      {reauth ? <ReconnectChip reauth={reauth} /> : null}
      </div>
      <div className="zen-phase-body" data-open={open}>
        <div
          ref={setLiveScroller}
          className={active || !open ? "zen-phase-live" : undefined}
        >
          <div className="flex min-w-0 flex-col">
            {phase.steps.map((block) => (
              <div
                key={block.id}
                className={`zen-phase-step${active ? " zen-step-in" : ""}`}
              >
                <ActivityRow
                  block={block}
                  cwd={cwd}
                  variant="phase"
                  live={active}
                  onApproval={onApproval}
                  onOpenFile={onOpenFile}
                  onOpenDiff={onOpenDiff}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      {!open && edits.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1 pb-1 pl-5">
          {edits.flatMap((block) => splitEditCards(block).cards).map((block) => (
            <EditRow
              key={block.id}
              block={block}
              cwd={cwd}
              onOpenFile={onOpenDiff ?? onOpenFile}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What the group was for, at a glance: look, change, run, think. */
export function ActivityPhaseIcon({
  kind,
  className = "",
}: {
  kind: ActivityPhaseKind;
  className?: string;
}) {
  const props = {
    className: `size-3.5 shrink-0 text-content/40 ${className}`,
    strokeWidth: 1.75,
  };
  if (kind === "edit") return <PenLine {...props} />;
  if (kind === "research") return <Search {...props} />;
  if (kind === "run") return <Terminal {...props} />;
  if (kind === "think") return <Sparkles {...props} />;
  if (kind === "other") return <Wrench {...props} />;
  return <Minus {...props} />;
}

/** Within a line or two of the end of a nested scroller. */
export function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
}
