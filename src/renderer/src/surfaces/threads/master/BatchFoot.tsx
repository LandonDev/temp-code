import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { registerToastAnchor } from "../../../lib/toastAnchor";
import type { BatchState } from "@server/shared/contract-batch";
import { Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent } from "../../../components/ui/collapsible";
import { DISCLOSURE_CHEVRON } from "../../../components/ui/disclosure";
import { Skeleton } from "../../../components/ui/skeleton";
import { StatusMark } from "../../../components/ui/status";
import { ChevronRight, Square } from "../../../chrome/icons";
import { cn } from "../../../lib/cn";
import { useNow } from "../../../lib/duration";
import { RulesDialog } from "./RulesDialog";
import { consoleStep, liveSteps, nearBottom, stepDetail, stepState, stepTime, consoleLines, hasConsole, type LiveStep } from "./steps";
import { blockedLine, type Rules } from "./useMasterModel";
import { CONSOLE } from "../../../components/ui/console";

/**
 * Under the list, what happens when the threads are done (docs/LAYOUT.md
 * "Master"): a "When done" heading with Edit, one row per step the master
 * wrote, in order (its glyph, its name, what it is about, its time), and
 * a last line saying what happens then. The running step's console opens
 * under its own row, the same for a shell step (its first line is the
 * command) as for a publish, newest line at the bottom and following
 * until the person scrolls up, Stop on the row; a failed step's console
 * stays open with its last lines until Hide. The console folds through
 * `Collapsible`. Its text sits on the board's 12px inset. Until
 * `batch.board` answers the foot alone is a still skeleton of the same
 * shape (the rows above it paint from the store at once). Read from the
 * `batch` push; Edit writes `batch.setRules`, Stop `batch.stopStep` with
 * the step's id.
 */

const LOG_LINES = 200;

export function BatchFoot({
  batch,
  loaded = true,
  titleOf,
  hostName,
  onSave,
  onStop,
  toastAnchor = false,
}: {
  batch: BatchState;
  /** False until the board's first answer: the foot is its skeleton. */
  loaded?: boolean;
  /** A child's title by id, for the blocked line. */
  titleOf: (id: string) => string | undefined;
  /** A host's name by id, for a blocked child out of reach on it. */
  hostName?: (environmentId: string) => string | undefined;
  onSave: (rules: Rules) => Promise<void>;
  onStop: (stepId: string) => Promise<void>;
  /** The master's chat is folded: the toast stack sits above this foot, not over it. */
  toastAnchor?: boolean;
}) {
  const rules = batch.rules;
  const [editing, setEditing] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const steps = liveSteps(batch);
  const active = consoleStep(steps, folded);
  const running = steps.some((s) => s.status === "running");
  // A step that runs again after a fold unfolds it.
  if (running && folded.size > 0) setFolded(new Set());
  const now = useNow(running);
  const blocked = blockedLine(batch, titleOf, hostName);
  // One Stop and one fold for every row, so a row renders again only for
  // what it shows (a log line on the running step re-renders that row alone).
  const stopRef = useRef(onStop);
  useLayoutEffect(() => {
    stopRef.current = onStop;
  });
  const stopStep = useCallback((id: string) => stopRef.current(id), []);
  const fold = useCallback((id: string, hide: boolean) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (hide) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  if (!loaded) return <FootSkeleton toastAnchor={toastAnchor} />;

  return (
    <div
      ref={toastAnchor ? registerToastAnchor : undefined}
      className="flex shrink-0 flex-col border-t border-border bg-background px-3 py-2"
      data-batch-foot
      data-foot-mode={active ? "console" : "idle"}
    >
      <div className="flex h-6 items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">When done</h3>
        <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>
      {blocked ? (
        <p className="text-xs text-destructive" data-blocked>
          {blocked}
        </p>
      ) : null}

      <ol className="mt-1 flex flex-col">
        {steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            detail={stepDetail(step, rules)}
            now={step.status === "running" ? now : 0}
            open={active?.id === step.id}
            onStop={stopStep}
            onFold={fold}
          />
        ))}
      </ol>

      <p className="mt-1 text-xs text-muted-foreground" data-then>
        {rules.then === "archive-children" ? "Then archive the threads" : "Then notify you"}
      </p>

      {editing ? <RulesDialog rules={rules} onClose={() => setEditing(false)} onSave={onSave} /> : null}
    </div>
  );
}

/** The foot's shape before the answer: the heading and two step rows, still. */
function FootSkeleton({ toastAnchor }: { toastAnchor: boolean }) {
  return (
    <div
      ref={toastAnchor ? registerToastAnchor : undefined}
      className="flex shrink-0 flex-col border-t border-border bg-background px-3 py-2"
      data-batch-foot
      data-foot-mode="loading"
      aria-busy="true"
    >
      <div className="flex h-6 items-center">
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="mt-1 flex flex-col">
        {[0, 1].map((i) => (
          <div key={i} className="flex h-7 items-center gap-2">
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One step: its glyph, its name, what it is about, its time, and Stop
 *  while it runs (Hide or Show on a failed one); its console under it. */
type StepRowProps = {
  step: LiveStep;
  detail: ReturnType<typeof stepDetail>;
  /** The clock, for the running step alone; 0 for the rest. */
  now: number;
  open: boolean;
  onStop: (id: string) => Promise<void>;
  onFold: (id: string, hide: boolean) => void;
};

/** A step's own facts, by value: the steps are rebuilt on every batch push. The log is bounded (200 lines), so it is read whole. */
function sameStep(a: LiveStep, b: LiveStep): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.name === b.name &&
      a.kind === b.kind &&
      a.run === b.run &&
      a.status === b.status &&
      a.detail === b.detail &&
      a.startedAt === b.startedAt &&
      a.endedAt === b.endedAt &&
      JSON.stringify(a.progress) === JSON.stringify(b.progress) &&
      a.log.length === b.log.length &&
      a.log.every((line, i) => line === b.log[i]))
  );
}

const sameRow = (a: StepRowProps, b: StepRowProps): boolean =>
  a.now === b.now &&
  a.open === b.open &&
  a.onStop === b.onStop &&
  a.onFold === b.onFold &&
  a.detail.text === b.detail.text &&
  a.detail.label === b.detail.label &&
  sameStep(a.step, b.step);

const StepRow = memo(function StepRow({ step, detail, now, open, onStop, onFold }: StepRowProps) {
  const time = stepTime(step, now);
  const quiet = step.status === "pending" || step.status === "skipped";
  const failed = step.status === "failed";
  const [stopping, setStopping] = useState(false);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop(step.id);
    } finally {
      setStopping(false);
    }
  };

  return (
    <li data-step={step.id} data-step-status={step.status}>
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <StatusMark state={stepState(step.status)} word={false} />
        {/* The name, its detail and the time on one baseline, 4px apart. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className={cn("shrink-0 text-[13px] leading-5", quiet ? "text-muted-foreground" : "text-foreground")}>{step.name}</span>
          {/* A failure is said only here, so it wraps rather than being cut. */}
          <span className={cn("min-w-0 flex-1 text-xs", failed ? "py-1.5 break-words text-destructive" : "truncate text-muted-foreground")} data-step-detail>
            {detail.text || detail.label ? <span className="tabular-nums">{[detail.text, detail.label].filter(Boolean).join(", ")}</span> : null}
          </span>
          {time ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-step-time>
              {time}
            </span>
          ) : null}
        </span>
        {step.status === "running" ? (
          <Button variant="ghost" size="xs" onClick={() => void stop()} disabled={stopping}>
            <Square className="size-3" />
            Stop
          </Button>
        ) : failed && hasConsole(step) ? (
          <Button variant="ghost" size="xs" onClick={() => onFold(step.id, open)} aria-expanded={open}>
            {open ? "Hide" : "Show"}
            <ChevronRight className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />
          </Button>
        ) : null}
      </div>
      <Collapsible open={open}>
        <CollapsibleContent>{open ? <Console step={step} /> : null}</CollapsibleContent>
      </Collapsible>
    </li>
  );
}, sameRow);

/** A step's console lines, oldest first, following the newest while the
 *  person has not scrolled up. A failed step's failure is its row's detail,
 *  never repeated here. */
function Console({ step }: { step: LiveStep }) {
  const lines = consoleLines(step, LOG_LINES);
  const logRef = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    follow.current = true;
  }, [step.id]);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, step.id]);

  return (
    <pre
      ref={logRef}
      onScroll={(e) => {
        follow.current = nearBottom(e.currentTarget);
      }}
      data-console={step.id}
      data-log
      tabIndex={0}
      className={cn(CONSOLE, "mb-1 ml-[22px] max-h-44 min-h-15 overflow-x-hidden overflow-y-auto whitespace-pre-wrap")}
    >
      {lines.length > 0 ? lines.join("\n") : "Starting…"}
    </pre>
  );
}
