import { useLayoutEffect, useRef, useState } from "react";
import type { BatchState } from "@server/shared/contract-batch";
import { Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent } from "../../../components/ui/collapsible";
import { Skeleton } from "../../../components/ui/skeleton";
import { StatusMark } from "../../../components/ui/status";
import { ChevronDown, Square } from "../../../chrome/icons";
import { cn } from "../../../lib/cn";
import { useNow } from "../../../lib/duration";
import { RulesDialog } from "./RulesDialog";
import { consoleStep, liveSteps, nearBottom, stepDetail, stepState, stepTime, consoleLines, type LiveStep } from "./steps";
import { blockedLine, type Rules } from "./useMasterModel";

/**
 * Under the list, what happens when the threads are done (docs/LAYOUT.md
 * "Master"): a "When done" heading with Edit, one row per step the master
 * wrote, in order (its glyph, its name, what it is about, its time), and
 * a last line saying what happens then. The running step's console opens
 * under its own row, the same for a shell step (its first line is the
 * command) as for a publish, newest line at the bottom and following
 * until the person scrolls up, Stop on the row; a failed step's console
 * stays open with its last lines until Hide. The console folds through
 * `Collapsible`. Until `batch.board` answers the foot is a skeleton of the
 * same shape. Read from the `batch` push; Edit writes `batch.setRules`,
 * Stop `batch.stopStep` with the step's id.
 */

const LOG_LINES = 200;

export function BatchFoot({
  batch,
  loaded = true,
  titleOf,
  hostName,
  onSave,
  onStop,
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

  if (!loaded) return <FootSkeleton />;

  const fold = (id: string, hide: boolean) => {
    const next = new Set(folded);
    if (hide) next.add(id);
    else next.delete(id);
    setFolded(next);
  };

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-background px-5 py-3" data-batch-foot data-foot-mode={active ? "console" : "idle"}>
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
            rules={rules}
            now={now}
            open={active?.id === step.id}
            onStop={() => onStop(step.id)}
            onFold={(hide) => fold(step.id, hide)}
          />
        ))}
      </ol>

      <p className="mt-2 text-xs text-muted-foreground" data-then>
        {rules.then === "archive-children" ? "Then archive the threads" : "Then notify you"}
      </p>

      {editing ? <RulesDialog rules={rules} onClose={() => setEditing(false)} onSave={onSave} /> : null}
    </div>
  );
}

/** The foot's shape before the answer: the heading and three step rows. */
function FootSkeleton() {
  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-background px-5 py-3" data-batch-foot data-foot-mode="loading" aria-busy="true">
      <div className="flex h-6 items-center">
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="mt-1 flex flex-col">
        {[0, 1, 2].map((i) => (
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
function StepRow({
  step,
  rules,
  now,
  open,
  onStop,
  onFold,
}: {
  step: LiveStep;
  rules: Rules;
  now: number;
  open: boolean;
  onStop: () => Promise<void>;
  onFold: (hide: boolean) => void;
}) {
  const time = stepTime(step, now);
  const detail = stepDetail(step, rules);
  const quiet = step.status === "pending" || step.status === "skipped";
  const failed = step.status === "failed";
  const [stopping, setStopping] = useState(false);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };

  return (
    <li data-step={step.id} data-step-status={step.status}>
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <StatusMark state={stepState(step.status)} word={false} />
        <span className={cn("shrink-0 text-[13px]", quiet ? "text-muted-foreground" : "text-foreground")}>{step.name}</span>
        {/* A failure is said only here, so it wraps rather than being cut. */}
        <span className={cn("min-w-0 flex-1 text-xs", failed ? "py-1.5 break-words text-destructive" : "truncate text-muted-foreground")} data-step-detail>
          {detail.text ? <span className="tabular-nums">{detail.text}</span> : null}
          {detail.label ? <span className="ml-2">{detail.label}</span> : null}
        </span>
        {time ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-step-time>
            {time}
          </span>
        ) : null}
        {step.status === "running" ? (
          <Button variant="ghost" size="xs" onClick={() => void stop()} disabled={stopping}>
            <Square className="size-3" />
            Stop
          </Button>
        ) : failed ? (
          <Button variant="ghost" size="xs" onClick={() => onFold(open)} aria-expanded={open}>
            {open ? "Hide" : "Show"}
            <ChevronDown className={cn("size-3 transition-transform duration-(--dur-fast)", open && "rotate-180")} />
          </Button>
        ) : null}
      </div>
      <Collapsible open={open}>
        <CollapsibleContent>{open ? <Console step={step} /> : null}</CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** A step's console lines, oldest first, following the newest while the
 *  person has not scrolled up. A failed step's failure is its row's detail,
 *  never repeated here. */
function Console({ step }: { step: LiveStep }) {
  const failed = step.status === "failed";
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
      className="mb-1 ml-[22px] max-h-44 min-h-15 overflow-y-auto rounded-lg bg-card px-3 py-2 font-mono text-xs leading-[1.5] whitespace-pre-wrap text-muted-foreground"
    >
      {lines.length > 0 ? lines.join("\n") : failed ? "No output" : "Starting…"}
    </pre>
  );
}
